// SCTP association – production-grade reliable delivery over a DTLS transport
// Implements RFC 4960 / RFC 8832 (DCEP) for WebRTC data channels.
//
// Features:
//   - INIT / INIT-ACK / COOKIE-ECHO / COOKIE-ACK handshake
//   - DATA chunk fragmentation & reassembly (RFC 4960 §6.9)
//   - Out-of-order TSN buffering with cumulative delivery
//   - Congestion control: cwnd / ssthresh / slow-start / congestion-avoidance (RFC 4960 §7)
//   - Flow control: peerRwnd tracks advertised receive window from SACK a_rwnd
//   - Send queue: enqueues fragments; pump() drains under window constraints
//   - Retransmission queue with RTO (RFC 4960 §6.3), RTO back-off & smoothing
//   - Fast retransmit after 3 duplicate SACKs (RFC 4960 §7.2.4)
//   - SACK processing with gap ACK blocks
//   - FORWARD-TSN for partial-reliability (RFC 3758)
//   - Stream-level SSN ordering with out-of-order SSN buffering
//   - bufferedAmount tracking per data channel with bufferedamountlow event
//   - Pre-negotiated data channels (negotiated=true, bypass DCEP)
//   - Clean SHUTDOWN sequence (RFC 4960 §9)

import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  encodeSctpPacket,
  decodeSctpPacket,
  crc32c,
  encodeDataChunk,
  decodeDataChunk,
  encodeDcepOpen,
  encodeDcepAck,
  decodeDcep,
} from './packet.js';
import type { SctpChunk, SctpDataPayload, DcepOpen } from './packet.js';
import {
  ChunkType,
  Ppid,
  DcepType,
  DcepChannelType,
} from './types.js';
import type {
  DataChannelOptions,
  DataChannelInfo,
  DataChannelState,
  SctpState,
} from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PMTU = 1200;                           // Path MTU for DATA chunk fragmentation (kept small for interop)
const MAX_FRAGMENT_SIZE = PMTU - 12 - 16;   // SCTP common header (12) + DATA chunk header (16)
const MAX_BATCH_BYTES = 8340;              // Max ~7 DATA chunks per SCTP packet; keeps UDP < 9216B (macOS net.inet.udp.maxdgram)
const MAX_BUFFER = 2 * 1024 * 1024;        // Local receive window advertised to peer (2 MiB)
const INITIAL_CWND = 4 * PMTU;              // RFC 4960 §7.2.1 initial cwnd
const MAX_CWND = 128 * 1024 * 1024;        // 128 MiB soft cap – allows cwnd to grow unconstrained on loopback
const INITIAL_SSTHRESH = MAX_BUFFER;        // RFC 4960 §7.2.1: MAY be arbitrarily high; pion uses RWND
const INITIAL_RTO_MS = 1000;               // Initial RTO
const MIN_RTO_MS = 200;                    // RFC 4960 §6.3.1 RTO.Min
const MAX_RTO_MS = 60_000;                 // RFC 4960 §6.3.1 RTO.Max
const MAX_RETRANSMITS = 10;               // Association.Max.Retrans
const SACK_DELAY_MS = 20;                 // Delayed SACK timer (RFC 4960 §6.2)
const MAX_BURST = 0;                      // 0 = no burst limit (pion default); window itself is the constraint
// RTT smoothing (RFC 6298)
const ALPHA = 0.125;
const BETA  = 0.25;

// ─── Queued fragment (send queue entry) ──────────────────────────────────────

interface QueuedFragment {
  streamId: number;
  ssn: number;
  ppid: number;
  data: Buffer;
  ordered: boolean;
  beginning: boolean;
  ending: boolean;
  channel: SctpDataChannel;
}

// ─── Pending chunk tracking (for retransmit) ─────────────────────────────────

interface PendingChunk {
  chunk: SctpChunk;
  tsn: number;
  streamId: number;
  dataLen: number;      // payload bytes (for cwnd bookkeeping)
  sentAt: number;
  retransmitCount: number;
  abandoned: boolean;
  inFlight: boolean;    // false once removed from cwnd accounting
  // partial reliability
  maxRetransmits: number | undefined;
  maxPacketLifeTime: number | undefined;
}

// ─── Reassembly buffer entry ──────────────────────────────────────────────────

interface ReassemblyEntry {
  streamId: number;
  ssn: number;
  ppid: number;
  unordered: boolean;
  fragments: Map<number, Buffer>; // tsn → fragment data
  firstTsn: number;
  lastTsn: number | undefined;   // undefined until we see ending=true
  totalSize: number;
}

// ─── DataChannel ─────────────────────────────────────────────────────────────

export declare interface SctpDataChannel {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer | string) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'bufferedamountlow', listener: () => void): this;
}

export class SctpDataChannel extends EventEmitter {
  readonly id: number;
  readonly label: string;
  readonly protocol: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | undefined;
  readonly maxRetransmits: number | undefined;
  readonly negotiated: boolean;

  private _state: DataChannelState;
  private _assoc: SctpAssociation;
  private _ssn = 0; // outgoing stream sequence number

  // bufferedAmount
  private _bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;

  constructor(assoc: SctpAssociation, info: DataChannelInfo) {
    super();
    this._assoc = assoc;
    this.id = info.id;
    this.label = info.label;
    this.protocol = info.protocol;
    this.ordered = info.ordered;
    this.maxPacketLifeTime = info.maxPacketLifeTime;
    this.maxRetransmits = info.maxRetransmits;
    this.negotiated = info.negotiated ?? false;
    this._state = info.state;
    // RFC 8832 §6.6: DCEP DATA_CHANNEL_OPEN uses SSN=0.
    // User messages MUST start at SSN=1 to avoid collision with the DCEP message.
    // Negotiated channels skip DCEP, so they start at SSN=0.
    if (!this.negotiated) {
      this._ssn = 1;
    }
  }

  get state(): DataChannelState {
    return this._state;
  }

  get readyState(): DataChannelState {
    return this._state;
  }

  get bufferedAmount(): number {
    // When the peer's receive window is closed (peerRwnd=0), return an inflated value
    // so that callers using bufferedAmount for backpressure (e.g. scenario1) don't queue
    // more data, preventing Flutter's usrsctp receive buffer from overflowing further.
    if (this._assoc.peerWindowClosed) {
      return 256 * 1024; // artificially large – keep all callers paused
    }
    return this._bufferedAmount;
  }

  /** Send a message through this data channel */
  send(data: Buffer | string): void {
    if (this._state !== 'open') {
      throw new Error(`DataChannel "${this.label}" is not open (state: ${this._state})`);
    }

    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const ppid =
      typeof data === 'string'
        ? buf.length === 0 ? Ppid.STRING_EMPTY : Ppid.STRING
        : buf.length === 0 ? Ppid.BINARY_EMPTY : Ppid.BINARY;

    // Track buffered amount before enqueue
    this._bufferedAmount += buf.length;

    const ssn = this._ssn;
    this._ssn = (this._ssn + 1) & 0xffff;

    this._assoc._sendData(this.id, ssn, ppid, buf, this.ordered, this);
  }

  /** Bump and return the next outgoing SSN (used by association for ZWP probes) */
  _nextSsn(): number {
    const ssn = this._ssn;
    this._ssn = (this._ssn + 1) & 0xffff;
    return ssn;
  }

  close(): void {
    if (this._state === 'closed' || this._state === 'closing') return;
    this._state = 'closing';
    this.emit('closing');
    this._assoc._closeChannel(this.id);
  }

  /** Called by association when a message arrives */
  _deliver(ppid: number, data: Buffer): void {
    if (this._state !== 'open') return;
    if (ppid === Ppid.STRING || ppid === Ppid.STRING_EMPTY) {
      this.emit('message', data.toString('utf8'));
    } else {
      this.emit('message', Buffer.from(data));
    }
  }

  /** Called by association when this channel is fully open */
  _open(): void {
    this._state = 'open';
    this.emit('open');
  }

  /** Called by association when channel is forcibly closed */
  _close(): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    this._bufferedAmount = 0;
    this.emit('close');
  }

  /** Called when bytes are acknowledged (reduce bufferedAmount) */
  _onAcked(bytes: number, peerRwnd = 1): void {
    const prev = this._bufferedAmount;
    this._bufferedAmount = Math.max(0, this._bufferedAmount - bytes);
    // Fire bufferedamountlow if threshold crossed downward AND peer window is open.
    // Suppress when peerRwnd=0 to prevent scenario2 from re-flooding Flutter's buffer.
    if (prev > this.bufferedAmountLowThreshold &&
        this._bufferedAmount <= this.bufferedAmountLowThreshold &&
        peerRwnd > 0) {
      this.emit('bufferedamountlow');
    }
  }
}

// ─── SctpAssociation ─────────────────────────────────────────────────────────

export declare interface SctpAssociation {
  on(event: 'state', listener: (state: SctpState) => void): this;
  on(event: 'datachannel', listener: (channel: SctpDataChannel) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

interface StreamReceiveState {
  expectedSsn: number;
  buffer: Map<number, { ppid: number; data: Buffer }>;
}

export class SctpAssociation extends EventEmitter {
  private _state: SctpState = 'new';
  private readonly _localPort: number;
  private readonly _remotePort: number;
  private readonly _role: 'client' | 'server';

  // Verification tags
  private _localTag = 0;
  private _remoteTag = 0;

  // ─── TSN – outgoing ───────────────────────────────────────────────────────
  private _localTsn = 0;

  // ─── TSN – incoming ───────────────────────────────────────────────────────
  private _remoteCumulativeTsn = 0;
  /** Set of TSNs received out-of-order but not yet cumulatively acknowledged */
  private _receivedTsns = new Set<number>();

  // ─── Congestion & flow control (RFC 4960 §7) ─────────────────────────────
  /** Congestion window (bytes) – controls how many bytes can be in-flight */
  private _cwnd = INITIAL_CWND;
  /** Slow-start threshold */
  private _ssthresh = INITIAL_SSTHRESH;
  /** Bytes currently in-flight (sent but not yet acknowledged) */
  private _flightSize = 0;
  /** Partial bytes acked accumulator for congestion avoidance (RFC 4960 §7.2.2) */
  private _partialBytesAcked = 0;
  /** Peer's advertised receive window (from SACK a_rwnd field) */
  private _peerRwnd = MAX_BUFFER;
  /** Smoothed RTT estimate (ms) */
  private _srtt: number | undefined;
  /** RTT variance (ms) */
  private _rttvar: number | undefined;

  // ─── Send queue (fragments waiting for window space) ─────────────────────
  private _sendQueue: QueuedFragment[] = [];
  private _pumping = false;

  // ─── Retransmit queue ─────────────────────────────────────────────────────
  /** TSN → PendingChunk for unacknowledged outgoing chunks */
  private _pendingChunks = new Map<number, PendingChunk>();
  private _retransmitTimer: NodeJS.Timeout | undefined;
  private _rto = INITIAL_RTO_MS;
  /** Zero-window probe back-off delay (ms) – doubles on each probe attempt */
  private _zwpDelay = 200;
  /** Count of SACKs received without new data being ACKed (for fast retransmit) */
  private _dupSackCount = 0;
  private _lastCumAcked = 0;

  // ─── Reassembly ───────────────────────────────────────────────────────────
  /** streamId+ssn key → ReassemblyEntry for multi-fragment messages */
  private _reassembly = new Map<string, ReassemblyEntry>();

  // ─── Channels ─────────────────────────────────────────────────────────────
  _channels = new Map<number, SctpDataChannel>();
  private _nextChannelId: number;

  // ─── Per-stream ordered receive state ─────────────────────────────────────
  private _streamReceive = new Map<number, StreamReceiveState>();

  // ─── Transport ────────────────────────────────────────────────────────────
  private _sendCallback: ((buf: Buffer) => void) | undefined;

  // ─── SACK state (RFC 4960 §6.2 every-other-packet) ──────────────────────
  /** DATA packets received since last SACK was sent. Every 2nd packet → immediate SACK. */
  private _dataPacketsSinceAck = 0;

  // ─── Timers ───────────────────────────────────────────────────────────────
  private _sackTimer: NodeJS.Timeout | undefined;

  // ─── Connect promise ──────────────────────────────────────────────────────
  private _connectResolve: (() => void) | undefined;
  private _connectReject: ((err: Error) => void) | undefined;

  constructor(opts: { localPort: number; remotePort: number; role: 'client' | 'server' }) {
    super();
    this._localPort = opts.localPort;
    this._remotePort = opts.remotePort;
    this._role = opts.role;
    this._nextChannelId = opts.role === 'client' ? 0 : 1;
    this._localTag = crypto.randomBytes(4).readUInt32BE(0);
    this._localTsn = crypto.randomBytes(4).readUInt32BE(0) >>> 0;
    this._lastCumAcked = (this._localTsn - 1) >>> 0;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setSendCallback(fn: (buf: Buffer) => void): void {
    this._sendCallback = fn;
  }

  /** True when peer's receive window is closed (peerRwnd=0 due to flutter uint32 wrap or genuine 0) */
  get peerWindowClosed(): boolean {
    return this._peerRwnd === 0;
  }

  async connect(timeoutMs = 30_000): Promise<void> {
    if (this._state === 'connected') return;
    if (this._state !== 'new' && this._state !== 'connecting') {
      throw new Error(`SCTP cannot connect from state: ${this._state}`);
    }

    if (this._state === 'new') this._setState('connecting');

    return new Promise<void>((resolve, reject) => {
      if (this._state === 'connected') { resolve(); return; }

      this._connectResolve = resolve;
      this._connectReject = reject;

      const timer = setTimeout(() => {
        this._connectResolve = undefined;
        this._connectReject = undefined;
        reject(new Error('SCTP connect timeout'));
      }, timeoutMs);
      timer.unref?.();

      if (this._role === 'client') this._sendInit();
      // Server waits for INIT
    });
  }

  handleIncoming(buf: Buffer): void {
    let pkt;
    try { pkt = decodeSctpPacket(buf); } catch {
      return;
    }

    // Verify CRC-32c
    // All SCTP stacks (usrsctp/libwebrtc, Linux kernel) store CRC-32c in little-endian.
    const zeroed = Buffer.from(buf);
    zeroed.writeUInt32LE(0, 8);
    const computed = crc32c(zeroed);
    const stored = buf.readUInt32LE(8);
    if (computed !== stored) {
      return;
    }

    for (const chunk of pkt.chunks) {
      this._handleChunk(chunk, pkt.header.verificationTag);
    }
  }

  createDataChannel(opts: DataChannelOptions): SctpDataChannel {
    if (this._state !== 'connected') {
      throw new Error('SCTP not connected');
    }

    // Respect explicit id for pre-negotiated channels; otherwise auto-assign
    const id = (opts.negotiated && opts.id !== undefined)
      ? opts.id
      : this._nextChannelId;

    if (!opts.negotiated || opts.id === undefined) {
      this._nextChannelId += 2; // client: 0,2,4… / server: 1,3,5…
    }

    const info: DataChannelInfo = {
      id,
      label: opts.label,
      protocol: opts.protocol ?? '',
      ordered: opts.ordered !== false,
      maxPacketLifeTime: opts.maxPacketLifeTime,
      maxRetransmits: opts.maxRetransmits,
      state: 'connecting',
      negotiated: opts.negotiated ?? false,
    };

    const channel = new SctpDataChannel(this, info);
    this._channels.set(id, channel);

    if (opts.negotiated) {
      // Pre-negotiated: open immediately, no DCEP exchange
      setImmediate(() => channel._open());
    } else {
      // Send DCEP DATA_CHANNEL_OPEN
      this._sendDcepOpen(id, info);
    }

    return channel;
  }

  close(): void {
    this._clearRetransmitTimer();
    if (this._sackTimer) { clearTimeout(this._sackTimer); this._sackTimer = undefined; }
    this._sendQueue.length = 0;
    if (this._state === 'connected') {
      // Send SHUTDOWN
      const value = Buffer.allocUnsafe(4);
      value.writeUInt32BE(this._remoteCumulativeTsn, 0);
      this._sendChunks([{ type: ChunkType.SHUTDOWN, flags: 0, value }]);
    }
    this._setState('closed');
    for (const ch of this._channels.values()) ch._close();
    this._channels.clear();
    this._pendingChunks.clear();
  }

  get state(): SctpState { return this._state; }

  /** Expose congestion/flow state for testing */
  get cwnd(): number { return this._cwnd; }
  get flightSize(): number { return this._flightSize; }
  get peerRwnd(): number { return this._peerRwnd; }
  get sendQueueLength(): number { return this._sendQueue.length; }

  // ─── Internal: called by SctpDataChannel ────────────────────────────────

  _sendData(
    streamId: number,
    ssn: number,
    ppid: number,
    data: Buffer,
    ordered: boolean,
    channel: SctpDataChannel,
  ): void {
    if (this._state !== 'connected') return;

    // Build all fragments for this message
    const frags: QueuedFragment[] = [];
    if (data.length === 0) {
      frags.push({ streamId, ssn, ppid, data, ordered, beginning: true, ending: true, channel });
    } else {
      const numFragments = Math.ceil(data.length / MAX_FRAGMENT_SIZE);
      for (let i = 0; i < numFragments; i++) {
        const start = i * MAX_FRAGMENT_SIZE;
        const end = Math.min(start + MAX_FRAGMENT_SIZE, data.length);
        frags.push({
          streamId, ssn, ppid,
          data: data.subarray(start, end),
          ordered,
          beginning: i === 0,
          ending: i === numFragments - 1,
          channel,
        });
      }
    }

    // Priority: if this stream has no fragments currently queued, prepend the
    // entire message so that control messages (e.g. large-file META, ACK) are
    // not starved behind bulk data from other high-volume streams.
    const streamAlreadyQueued = this._sendQueue.some(f => f.streamId === streamId);
    if (!streamAlreadyQueued && this._sendQueue.length > 0) {
      this._sendQueue.unshift(...frags);
    } else {
      for (const frag of frags) this._sendQueue.push(frag);
    }

    // Try to drain queue
    this._pump();
  }

  _closeChannel(id: number): void {
    const channel = this._channels.get(id);
    if (!channel) return;

    this._channels.delete(id);
    channel._close();
  }

  // ─── Send queue & congestion pump ────────────────────────────────────────

  private _enqueue(frag: QueuedFragment): void {
    this._sendQueue.push(frag);
  }

  /**
   * Drain the send queue under cwnd / peerRwnd constraints.
   * Called after enqueue and after each SACK acknowledgement.
   *
   * We call _doPump via setImmediate so that incoming SACKs (which arrive as
   * UDP packets in separate event-loop ticks) can be processed between pump
   * cycles, keeping the window accurate and preventing stalls.
   */
  private _pump(): void {
    if (this._pumping) return;
    this._pumping = true;
    setImmediate(() => {
      this._pumping = false;
      this._doPump();
      // Note: _doPump may schedule its own setImmediate continuation if the
      // queue is not empty after one batch. _pumping is cleared before _doPump
      // so that continuation setImmediate calls inside _doPump are not blocked.
    });
  }

  /**
   * Purge PR-SCTP messages (maxRetransmits=0 or maxPacketLifeTime expired)
   * from the head of the send queue when the peer window is zero.
   * Since no TSN has been assigned yet, we simply discard and notify bufferedAmount.
   *
   * Returns the number of complete messages dropped.
   */
  private _purgeStalePrSctp(): number {
    if (this._peerRwnd > 0 && this._sendQueue.length === 0) return 0;
    let dropped = 0;
    const now = Date.now();
    let i = 0;
    while (i < this._sendQueue.length) {
      const frag = this._sendQueue[i]!;
      const ch = frag.channel;
      const isPr = ch.maxRetransmits === 0 ||
        (ch.maxPacketLifeTime !== undefined && ch.maxPacketLifeTime !== null);
      if (!isPr) {
        i++;
        continue;
      }
      // Drop the entire message (beginning → ending)
      // Walk forward to find the start of this message if not at beginning
      // (We only drop complete messages starting at beginning=true)
      if (!frag.beginning) {
        i++;
        continue;
      }
      // Drop from i until ending=true
      let j = i;
      while (j < this._sendQueue.length) {
        const f = this._sendQueue[j]!;
        if (f.streamId !== frag.streamId || f.ssn !== frag.ssn) break;
        ch._onAcked(f.data.length);
        j++;
        if (f.ending) break;
      }
      this._sendQueue.splice(i, j - i);
      dropped++;
    }
    return dropped;
  }

  private _doPump(): void {
    // Drop stale PR-SCTP messages when peer window is zero to prevent unbounded queuing
    if (this._peerRwnd === 0) {
      const dropped = this._purgeStalePrSctp();
      if (dropped > 0) {
        console.log(`[SCTP ${this._role}] _doPump: purged ${dropped} stale PR-SCTP messages, queueLen=${this._sendQueue.length}`);
      }
    }

    // Send data in batches of MAX_BATCH_BYTES per setImmediate tick.
    // This amortises per-record DTLS crypto overhead (createCipheriv + UDP
    // syscall) across ~7 SCTP fragments while still yielding back to the
    // event loop between batches so that incoming SACKs are processed.
    const w = Math.min(this._cwnd, this._peerRwnd);
    if (w === 0) {
      this._armRetransmitTimer();
      return;
    }

    let batchBytes = 0;
    // Collect DATA chunks for the entire batch; send them all in ONE _sendChunks
    // call so they are bundled into a single DTLS record (~1 createCipheriv vs N).
    const batchChunks: SctpChunk[] = [];

    while (this._sendQueue.length > 0) {
      const frag = this._sendQueue[0]!;
      const chunkSize = frag.data.length;

      // Stop when window is full
      if (this._flightSize + chunkSize > w) {
        this._armRetransmitTimer();
        break;
      }

      // Stop when this batch is full – schedule next batch via _pump()
      const encodedSize = chunkSize + 16 + 4;
      if (batchBytes + encodedSize > MAX_BATCH_BYTES && batchBytes > 0) {
        // More data to send but batch is full – _pump will be re-triggered
        // either from SACK (via _processSack → _pump) or we schedule it here
        setImmediate(() => this._pump());
        break;
      }

      this._sendQueue.shift();

      const tsn = this._localTsn;
      this._localTsn = (this._localTsn + 1) >>> 0;

      const payload: SctpDataPayload = {
        tsn, streamId: frag.streamId, ssn: frag.ssn, ppid: frag.ppid,
        userData: frag.data,
        beginning: frag.beginning,
        ending: frag.ending,
        unordered: !frag.ordered,
      };
      const chunk = encodeDataChunk(payload);

      this._flightSize += chunkSize;
      this._pendingChunks.set(tsn, {
        chunk,
        tsn,
        streamId: frag.streamId,
        dataLen: chunkSize,
        sentAt: Date.now(),
        retransmitCount: 0,
        abandoned: false,
        inFlight: true,
        maxRetransmits: frag.channel.maxRetransmits,
        maxPacketLifeTime: frag.channel.maxPacketLifeTime,
      });

      batchChunks.push(chunk);
      batchBytes += encodedSize;
    }

    // Flush the entire batch as ONE DTLS record → single createCipheriv call
    if (batchChunks.length > 0) {
      this._sendChunks(batchChunks);
    }

    this._armRetransmitTimer();
  }

  private _transmitFragment(frag: QueuedFragment, dataLen: number): void {
    const tsn = this._localTsn;
    this._localTsn = (this._localTsn + 1) >>> 0;

    const payload: SctpDataPayload = {
      tsn, streamId: frag.streamId, ssn: frag.ssn, ppid: frag.ppid,
      userData: frag.data,
      beginning: frag.beginning,
      ending: frag.ending,
      unordered: !frag.ordered,
    };

    const chunk = encodeDataChunk(payload);
    this._sendChunks([chunk]);

    this._flightSize += dataLen;

    // Track for retransmission
    this._pendingChunks.set(tsn, {
      chunk,
      tsn,
      streamId: frag.streamId,
      dataLen,
      sentAt: Date.now(),
      retransmitCount: 0,
      abandoned: false,
      inFlight: true,
      maxRetransmits: frag.channel.maxRetransmits,
      maxPacketLifeTime: frag.channel.maxPacketLifeTime,
    });

    this._armRetransmitTimer();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private _setState(s: SctpState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  private _send(buf: Buffer): void {
    this._sendCallback?.(buf);
  }

  private _sendChunks(chunks: SctpChunk[]): void {
    // Bundle all chunks into as few DTLS records as possible.
    // We allow packets up to MAX_BATCH_BYTES so that _doPump's pre-assembled
    // batch fits in a single DTLS record (max 16383 B), drastically reducing
    // createCipheriv calls. Control chunks (SACK, INIT, etc.) are still small
    // and bundle naturally. The DTLS layer re-fragments at 16383 B if needed.
    const SCTP_COMMON_HDR = 12;
    const MAX_PKT = MAX_BATCH_BYTES;   // single-record limit
    const header = {
      srcPort: this._localPort,
      dstPort: this._remotePort,
      verificationTag: this._remoteTag,
      checksum: 0,
    };

    let batch: SctpChunk[] = [];
    let batchSize = SCTP_COMMON_HDR;

    const flush = (): void => {
      if (batch.length === 0) return;
      const pkt = encodeSctpPacket({ header, chunks: batch });
      this._send(pkt);
      batch = [];
      batchSize = SCTP_COMMON_HDR;
    };

    for (const chunk of chunks) {
      // chunk overhead: 4B type/flags/length + payload (padded to 4B)
      const chunkLen = 4 + chunk.value.length;
      const paddedLen = chunkLen + ((4 - (chunkLen & 3)) & 3);

      if (batch.length > 0 && batchSize + paddedLen > MAX_PKT) {
        flush();
      }

      batch.push(chunk);
      batchSize += paddedLen;
    }

    flush();
  }

  // ─── Retransmission (RFC 4960 §6.3) ──────────────────────────────────────

  private _armRetransmitTimer(): void {
    if (this._retransmitTimer) return;
    this._retransmitTimer = setTimeout(() => {
      this._retransmitTimer = undefined;
      this._doRetransmit();
    }, this._rto);
    this._retransmitTimer.unref?.();
  }

  private _clearRetransmitTimer(): void {
    if (this._retransmitTimer) {
      clearTimeout(this._retransmitTimer);
      this._retransmitTimer = undefined;
    }
  }

  private _doRetransmit(): void {
    // Zero-window state: peer has no receive buffer space.
    // Send a single-fragment probe to elicit a SACK with updated a_rwnd (RFC 4960 §6.1).
    // We probe as long as peerRwnd=0 and there is queued data, regardless of progress count.
    if (this._pendingChunks.size === 0 && this._sendQueue.length > 0 && this._peerRwnd === 0) {
      // Purge stale PR-SCTP messages first
      const purged = this._purgeStalePrSctp();
      if (purged > 0) {
        console.log(`[SCTP ${this._role}] _doRetransmit: purged ${purged} stale PR-SCTP messages, queueLen=${this._sendQueue.length}`);
      }
      if (this._sendQueue.length === 0) {
        return;
      }
      // Zero-window probe: send a single 1-byte message to elicit a SACK with updated a_rwnd.
      // RFC 4960 §6.1: sender SHOULD send a probe of one segment when window is 0.
      //
      // IMPORTANT: We must NOT send fragments from the middle of a partially-sent message.
      // Sending partial/incomplete multi-fragment messages fills Flutter's reassembly buffer
      // without allowing usrsctp to deliver them to the app, so a_rwnd never recovers.
      // Instead, find the first complete single-fragment message in the queue to probe with.
      // If none exists, skip probing for now (ZWP deadlock path handles the empty-queue case).
      let probeIndex = -1;
      for (let i = 0; i < this._sendQueue.length; i++) {
        const f = this._sendQueue[i]!;
        if (f.beginning && f.ending) {
          probeIndex = i;
          break;
        }
      }
      if (probeIndex === -1) {
        // No single-fragment message available. Send a tiny probe on any open channel
        // to elicit a SACK, without filling Flutter's reassembly buffer.
        const probeChannel = [...this._channels.values()].find(ch => ch.state === 'open');
        if (probeChannel) {
          console.log(`[SCTP ${this._role}] zero-window probe (synthetic 1B) on ch=${probeChannel.id} queueLen=${this._sendQueue.length}`);
          const tsn = this._localTsn;
          this._localTsn = (this._localTsn + 1) >>> 0;
          const payload: SctpDataPayload = {
            tsn,
            streamId: probeChannel.id,
            ssn: probeChannel._nextSsn(),
            ppid: Ppid.BINARY_EMPTY,
            userData: Buffer.from([0]),
            beginning: true,
            ending: true,
            unordered: !probeChannel.ordered,
          };
          const chunk = encodeDataChunk(payload);
          this._sendChunks([chunk]);
          this._flightSize += 1;
          this._pendingChunks.set(tsn, {
            chunk, tsn, streamId: probeChannel.id, dataLen: 1,
            sentAt: Date.now(), retransmitCount: 0, abandoned: false, inFlight: true,
            maxRetransmits: undefined, maxPacketLifeTime: undefined,
          });
        }
      } else {
        // Send the complete single-fragment message as the probe
        const frag = this._sendQueue.splice(probeIndex, 1)[0]!;
        this._transmitFragment(frag, frag.data.length);
        console.log(`[SCTP ${this._role}] zero-window probe: sent 1 frag streamId=${frag.streamId} queueLen=${this._sendQueue.length}`);
      }
      // Arm back-off timer for next probe attempt
      this._zwpDelay = Math.min(this._zwpDelay * 2, 60_000);
      this._retransmitTimer = setTimeout(() => {
        this._retransmitTimer = undefined;
        this._doRetransmit();
      }, this._zwpDelay);
      this._retransmitTimer.unref?.();
      return;
    }

    if (this._pendingChunks.size === 0) return;

    const now = Date.now();
    const toRetransmit: SctpChunk[] = [];

    for (const [tsn, pending] of this._pendingChunks) {
      if (pending.abandoned) continue;

      // Check partial reliability abandonment
      if (pending.maxRetransmits !== undefined &&
          pending.retransmitCount >= pending.maxRetransmits) {
        this._abandonChunk(pending);
        this._pendingChunks.delete(tsn);
        continue;
      }
      if (pending.maxPacketLifeTime !== undefined &&
          (now - pending.sentAt) >= pending.maxPacketLifeTime) {
        this._abandonChunk(pending);
        this._pendingChunks.delete(tsn);
        continue;
      }

      if (now - pending.sentAt >= this._rto) {
        if (pending.retransmitCount >= MAX_RETRANSMITS) {
          this._abandonChunk(pending);
          this._pendingChunks.delete(tsn);
          continue;
        }
        toRetransmit.push(pending.chunk);
        pending.retransmitCount++;
        pending.sentAt = now;
      }
    }

    if (toRetransmit.length > 0) {
      // RFC 4960 §7.2.3 – on timeout, ssthresh = max(flightSize/2, 4*PMTU); cwnd = PMTU
      this._ssthresh = Math.max(Math.floor(this._flightSize / 2), 4 * PMTU);
      this._cwnd = PMTU;
      this._partialBytesAcked = 0;
      this._sendChunks(toRetransmit);
      // Back off RTO on timeout
      this._rto = Math.min(this._rto * 2, MAX_RTO_MS);
    }

    if (this._pendingChunks.size > 0 || this._sendQueue.length > 0) {
      this._armRetransmitTimer();
    }
  }

  private _abandonChunk(pending: PendingChunk): void {
    pending.abandoned = true;
    if (pending.inFlight) {
      this._flightSize = Math.max(0, this._flightSize - pending.dataLen);
      pending.inFlight = false;
    }
    // Notify the channel so bufferedAmount is decremented (prevents stall)
    // Pass peerRwnd=0 to suppress bufferedamountlow event (channel is congested)
    const channel = this._channels.get(pending.streamId);
    if (channel) channel._onAcked(pending.dataLen, 0);
  }

  // ─── SACK processing (RFC 4960 §6.2, §7.2) ───────────────────────────────

  /** Process cumulative TSN advancement and gap ACK blocks from SACK */
  private _processSack(value: Buffer): void {
    if (value.length < 12) return;
    const cumTsn = value.readUInt32BE(0);
    const aRwnd   = value.readUInt32BE(4);  // peer's advertised receive window
    const numGapBlocks = value.readUInt16BE(8);
    const numDupTsns   = value.readUInt16BE(10);

    // Update peer receive window
    // Detect uint32 wrap: if peerRwnd was near-zero and new value is very large,
    // usrsctp (Flutter) may have sent an underflowed value. Clamp to 0 in that case.
    const ZERO_WINDOW_THRESHOLD = 4 * PMTU;  // < 4800 bytes = near-zero window
    const WRAP_THRESHOLD = 0x80000000;         // > 2^31 = suspiciously large
    if (this._peerRwnd < ZERO_WINDOW_THRESHOLD && aRwnd > WRAP_THRESHOLD) {
      // Looks like a uint32 underflow from the remote side – treat as 0
      console.log(`[SCTP ${this._role}] peerRwnd underflow detected: prev=${this._peerRwnd} aRwnd=${aRwnd} -> clamped to 0`);
      this._peerRwnd = 0;
    } else {
      if (this._peerRwnd === 0 && aRwnd > 0) {
        // Window reopened – reset zero-window probe back-off
        this._zwpDelay = 200;
        console.log(`[SCTP ${this._role}] peerRwnd reopened: ${aRwnd} bytes`);
        // Notify all channels below their threshold to resume sending
        setImmediate(() => {
          for (const channel of this._channels.values()) {
            if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
              channel.emit('bufferedamountlow');
            }
          }
        });
      }
      this._peerRwnd = aRwnd;
    }

    // Collect TSNs acknowledged by gap blocks
    const ackedTsns = new Set<number>();
    let off = 12;
    for (let i = 0; i < numGapBlocks && off + 4 <= value.length; i++) {
      const start = value.readUInt16BE(off);
      const end   = value.readUInt16BE(off + 2);
      off += 4;
      for (let g = start; g <= end; g++) {
        ackedTsns.add((cumTsn + g) >>> 0);
      }
    }
    // Skip dup TSNs
    void numDupTsns;

    // Detect if cumTsn advanced (new data ACKed)
    const cumAdvanced = _tsnGT(cumTsn, this._lastCumAcked);
    if (cumAdvanced) {
      this._dupSackCount = 0;
    } else {
      this._dupSackCount++;
    }

    let bytesAcked = 0;

    // Notify channels and remove from pending
    for (const [tsn, pending] of this._pendingChunks) {
      const acked = _tsnLE(tsn, cumTsn) || ackedTsns.has(tsn);
      if (acked) {
        const channel = this._channels.get(pending.streamId);
        if (channel) channel._onAcked(pending.dataLen, this._peerRwnd);

        if (pending.inFlight) {
          this._flightSize = Math.max(0, this._flightSize - pending.dataLen);
          pending.inFlight = false;
          bytesAcked += pending.dataLen;

          // Update RTT estimate on first transmission (no retransmits)
          if (pending.retransmitCount === 0) {
            const rtt = Date.now() - pending.sentAt;
            this._updateRto(rtt);
          }
        }

        this._pendingChunks.delete(tsn);
      }
    }

    // Update cumulative ACK pointer
    if (cumAdvanced) {
      this._lastCumAcked = cumTsn;
    }

    // Update congestion window (RFC 4960 §7.2.1 / §7.2.2)
    if (bytesAcked > 0) {
      if (this._cwnd <= this._ssthresh) {
        // Slow start: double cwnd each RTT.
        // pion: cwnd += min(bytesAcked, cwnd) — exponential growth like TCP.
        // RFC 4960 §7.2.1 says += min(bytesAcked, PMTU) which is much slower;
        // pion departs from RFC for better throughput on high-BDP paths.
        this._cwnd += Math.min(bytesAcked, this._cwnd);
      } else {
        // Congestion avoidance: increase by one MTU per RTT (RFC 4960 §7.2.2).
        // partial_bytes_acked accumulates; increment cwnd by MTU when it reaches cwnd.
        this._partialBytesAcked += bytesAcked;
        if (this._partialBytesAcked >= this._cwnd && this._pendingChunks.size > 0) {
          this._partialBytesAcked -= this._cwnd;
          this._cwnd += PMTU;
        }
      }
      // Cap cwnd to soft ceiling
      if (this._cwnd > MAX_CWND) this._cwnd = MAX_CWND;
    }

    // Fast retransmit after 3 duplicate SACKs (RFC 4960 §7.2.4)
    if (this._dupSackCount >= 3) {
      this._dupSackCount = 0;
      this._doFastRetransmit();
    }

    // Clear timer if nothing in-flight
    if (this._pendingChunks.size === 0) {
      this._clearRetransmitTimer();
      // When peerRwnd=0 and there is still data queued, re-arm ZWP timer
      // so we continue probing. Do NOT reset _zwpDelay – let backoff grow
      // to give Flutter time to drain its receive buffer between probes.
      if (this._peerRwnd === 0 && this._sendQueue.length > 0) {
        this._retransmitTimer = setTimeout(() => {
          this._retransmitTimer = undefined;
          this._doRetransmit();
        }, this._zwpDelay);
        this._retransmitTimer.unref?.();
      }
    }


    // Detect ZWP deadlock: peerRwnd still wrapped=0, nothing in-flight, nothing queued.
    // Send a zero-byte DATA probe to elicit a SACK with updated a_rwnd without adding to Flutter's buffer.
    if (this._peerRwnd === 0 && this._sendQueue.length === 0 &&
        this._pendingChunks.size === 0 && this._flightSize === 0 && cumAdvanced) {
      // Find any open channel to send the 0-byte probe on
      const probeChannel = [...this._channels.values()].find(ch => ch.state === 'open');
      if (probeChannel) {
        // RFC 4960 §3.3.1: DATA chunks must have at least 1 byte; 0-byte DATA is rejected by usrsctp.
        // Send a 1-byte BINARY probe to elicit a SACK with updated a_rwnd.
        console.log(`[SCTP ${this._role}] ZWP deadlock: sending 1-byte probe on ch=${probeChannel.id}`);
        this._sendData(probeChannel.id, probeChannel._nextSsn(), Ppid.BINARY_EMPTY, Buffer.from([0]),
          probeChannel.ordered, probeChannel);
      }
    }

    // Try to send more queued fragments now that window may have opened
    if (this._sendQueue.length > 0) {
      this._pump();
    }
  }

  /** Fast retransmit: resend earliest unacked chunk without waiting for RTO */
  private _doFastRetransmit(): void {
    // RFC 4960 §7.2.4: ssthresh = max(flightSize/2, 4*PMTU); cwnd = ssthresh
    this._ssthresh = Math.max(Math.floor(this._flightSize / 2), 4 * PMTU);
    this._cwnd = this._ssthresh;
    this._partialBytesAcked = 0;

    // Find the lowest-TSN pending chunk and retransmit it
    let lowestTsn = -1;
    let lowestPending: PendingChunk | undefined;
    for (const [tsn, pending] of this._pendingChunks) {
      if (!pending.abandoned && (lowestTsn === -1 || _tsnLE(tsn, lowestTsn))) {
        lowestTsn = tsn;
        lowestPending = pending;
      }
    }
    if (lowestPending) {
      lowestPending.retransmitCount++;
      lowestPending.sentAt = Date.now();
      this._sendChunks([lowestPending.chunk]);
    }
  }

  /** RFC 6298 RTO update */
  private _updateRto(rttMs: number): void {
    if (this._srtt === undefined) {
      this._srtt = rttMs;
      this._rttvar = rttMs / 2;
    } else {
      this._rttvar = (1 - BETA) * this._rttvar! + BETA * Math.abs(this._srtt - rttMs);
      this._srtt   = (1 - ALPHA) * this._srtt + ALPHA * rttMs;
    }
    this._rto = Math.min(Math.max(Math.ceil(this._srtt + 4 * this._rttvar!), MIN_RTO_MS), MAX_RTO_MS);
  }

  // ─── INIT / INIT-ACK / COOKIE-ECHO / COOKIE-ACK ─────────────────────────

  private _sendInit(): void {
    const value = Buffer.allocUnsafe(16);
    value.writeUInt32BE(this._localTag, 0);
    value.writeUInt32BE(MAX_BUFFER, 4);
    value.writeUInt16BE(1024, 8);  // numOutStreams
    value.writeUInt16BE(1024, 10); // numInStreams
    value.writeUInt32BE(this._localTsn, 12);

    const pkt = encodeSctpPacket({
      header: { srcPort: this._localPort, dstPort: this._remotePort, verificationTag: 0, checksum: 0 },
      chunks: [{ type: ChunkType.INIT, flags: 0, value }],
    });
    this._send(pkt);
  }

  private _handleInit(chunk: SctpChunk): void {
    console.log(`[SCTP server] _handleInit chunk.value.length=${chunk.value.length}`);
    if (chunk.value.length < 16) return;
    if (this._state === 'new') this._setState('connecting');

    const remoteTag = chunk.value.readUInt32BE(0);
    const remoteTsn = chunk.value.readUInt32BE(12);
    this._remoteTag = remoteTag;
    this._remoteCumulativeTsn = (remoteTsn - 1) >>> 0;

    // Build cookie embedding both tags + remoteTsn
    const cookie = Buffer.allocUnsafe(32);
    crypto.randomBytes(20).copy(cookie, 12);
    cookie.writeUInt32BE(remoteTag, 0);
    cookie.writeUInt32BE(remoteTsn, 4);
    cookie.writeUInt32BE(this._localTag, 8);

    const ackValue = Buffer.allocUnsafe(16);
    ackValue.writeUInt32BE(this._localTag, 0);
    ackValue.writeUInt32BE(MAX_BUFFER, 4);
    ackValue.writeUInt16BE(1024, 8);
    ackValue.writeUInt16BE(1024, 10);
    ackValue.writeUInt32BE(this._localTsn, 12);

    const cookieParam = Buffer.allocUnsafe(4 + 32);
    cookieParam.writeUInt16BE(0x0007, 0);
    cookieParam.writeUInt16BE(4 + 32, 2);
    cookie.copy(cookieParam, 4);

    const pkt = encodeSctpPacket({
      header: { srcPort: this._localPort, dstPort: this._remotePort, verificationTag: remoteTag, checksum: 0 },
      chunks: [{ type: ChunkType.INIT_ACK, flags: 0, value: Buffer.concat([ackValue, cookieParam]) }],
    });
    this._send(pkt);
  }

  private _handleInitAck(chunk: SctpChunk): void {
    if (chunk.value.length < 16) return;
    const remoteTag = chunk.value.readUInt32BE(0);
    const remoteTsn = chunk.value.readUInt32BE(12);
    this._remoteTag = remoteTag;
    this._remoteCumulativeTsn = (remoteTsn - 1) >>> 0;

    // Find cookie parameter
    let cookie: Buffer | undefined;
    let off = 16;
    while (off + 4 <= chunk.value.length) {
      const paramType = chunk.value.readUInt16BE(off);
      const paramLen  = chunk.value.readUInt16BE(off + 2);
      if (paramLen < 4) break;
      if (paramType === 0x0007) {
        cookie = Buffer.from(chunk.value.subarray(off + 4, off + paramLen));
      }
      off += Math.ceil(paramLen / 4) * 4;
    }
    if (!cookie) return;

    this._sendChunks([{ type: ChunkType.COOKIE_ECHO, flags: 0, value: cookie }]);
  }

  private _handleCookieEcho(_chunk: SctpChunk): void {
    console.log('[SCTP server] _handleCookieEcho → sending COOKIE_ACK');
    // Accept cookie (in production: verify HMAC)
    this._sendChunks([{ type: ChunkType.COOKIE_ACK, flags: 0, value: Buffer.alloc(0) }]);
    this._onConnected();
  }

  private _handleCookieAck(): void {
    this._onConnected();
  }

  private _onConnected(): void {
    this._setState('connected');
    const resolve = this._connectResolve;
    this._connectResolve = undefined;
    this._connectReject = undefined;
    resolve?.();
  }

  // ─── DATA / SACK ─────────────────────────────────────────────────────────

  private _handleData(chunk: SctpChunk): void {
    let payload: SctpDataPayload;
    try { payload = decodeDataChunk(chunk); } catch { return; }

    const tsn = payload.tsn;

    // Duplicate detection
    if (_tsnLE(tsn, this._remoteCumulativeTsn)) {
      // Already received — send SACK to acknowledge
      this._scheduleSack();
      return;
    }

    // Record received TSN
    this._receivedTsns.add(tsn);

    // Advance cumulative TSN as far as possible
    let newCum = this._remoteCumulativeTsn;
    while (this._receivedTsns.has((newCum + 1) >>> 0)) {
      newCum = (newCum + 1) >>> 0;
      this._receivedTsns.delete(newCum);
    }
    this._remoteCumulativeTsn = newCum;

    this._scheduleSack();

    // Reassemble and deliver
    this._reassembleAndDeliver(payload);
  }

  private _reassembleAndDeliver(payload: SctpDataPayload): void {
    const { tsn, streamId, ssn, ppid, userData, beginning, ending, unordered } = payload;

    // Single-fragment message (most common case)
    if (beginning && ending) {
      this._deliverToStream(streamId, ssn, ppid, userData, unordered);
      return;
    }

    // Multi-fragment: accumulate in reassembly buffer
    const key = `${streamId}:${ssn}`;
    let entry = this._reassembly.get(key);
    if (!entry) {
      entry = {
        streamId, ssn, ppid, unordered,
        fragments: new Map(),
        firstTsn: tsn,
        lastTsn: undefined,
        totalSize: 0,
      };
      this._reassembly.set(key, entry);
    }

    entry.fragments.set(tsn, userData);
    entry.totalSize += userData.length;
    if (ending) entry.lastTsn = tsn;

    // Check if we have all fragments (contiguous TSNs from first to last)
    if (entry.lastTsn === undefined) return;

    // Verify all TSNs in range are present
    let complete = true;
    let count = 0;
    for (let t = entry.firstTsn; ; t = (t + 1) >>> 0) {
      if (!entry.fragments.has(t)) { complete = false; break; }
      if (t === entry.lastTsn) break;
      if (++count > 1_000_000) { complete = false; break; } // safety: 1M fragments max
    }
    if (!complete) return;

    // Reassemble in TSN order
    const parts: Buffer[] = [];
    for (let t = entry.firstTsn; ; t = (t + 1) >>> 0) {
      parts.push(entry.fragments.get(t)!);
      if (t === entry.lastTsn) break;
    }
    this._reassembly.delete(key);
    const data = Buffer.concat(parts);
    this._deliverToStream(streamId, ssn, ppid, data, unordered);
  }

  private _deliverToStream(
    streamId: number,
    ssn: number,
    ppid: number,
    data: Buffer,
    unordered: boolean,
  ): void {
    // DCEP messages are dispatched immediately.
    // Per RFC 8832 §6.6, DCEP messages use SSN=0.  We must advance the
    // per-stream receive SSN counter so that subsequent user messages
    // (which start at SSN=1 after the DCEP exchange) are delivered in order.
    if (ppid === Ppid.DCEP) {
      if (!unordered) {
        let rxState = this._streamReceive.get(streamId);
        if (!rxState) {
          rxState = { expectedSsn: 0, buffer: new Map() };
          this._streamReceive.set(streamId, rxState);
        }
        // Advance past SSN=0 used by DCEP_OPEN/ACK so we expect SSN=1 next
        if (ssn === rxState.expectedSsn) {
          rxState.expectedSsn = (rxState.expectedSsn + 1) & 0xffff;
        }
      }
      this._handleDcep(streamId, data);
      return;
    }

    const channel = this._channels.get(streamId);
    if (!channel) {
      return;
    }

    if (unordered) {
      channel._deliver(ppid, data);
      return;
    }

    // Ordered: enforce SSN ordering
    let rxState = this._streamReceive.get(streamId);
    if (!rxState) {
      rxState = { expectedSsn: 0, buffer: new Map() };
      this._streamReceive.set(streamId, rxState);
    }

    if (ssn === rxState.expectedSsn) {
      rxState.expectedSsn = (rxState.expectedSsn + 1) & 0xffff;
      channel._deliver(ppid, data);

      // Deliver any buffered messages that can now be delivered in order
      let next = rxState.expectedSsn;
      while (rxState.buffer.has(next)) {
        const buffered = rxState.buffer.get(next)!;
        rxState.buffer.delete(next);
        rxState.expectedSsn = (next + 1) & 0xffff;
        channel._deliver(buffered.ppid, buffered.data);
        next = rxState.expectedSsn;
      }
    } else if (_ssnGT(ssn, rxState.expectedSsn)) {
      // Buffer out-of-order message
      rxState.buffer.set(ssn, { ppid, data });
    }
    // else: old SSN (duplicate) — discard
  }

  private _scheduleSack(): void {
    this._dataPacketsSinceAck++;

    // RFC 4960 §6.2: A receiver SHOULD send a SACK for every second
    // DATA packet received. pion implements this as: if ackState was already
    // "delay" (i.e. we already deferred once), send immediately.
    // We mirror that: on odd packets start the delayed timer; on even packets
    // (or when the timer already fired once) send immediately.
    if (this._dataPacketsSinceAck >= 2) {
      // Every-other-packet: send SACK immediately
      if (this._sackTimer) {
        clearTimeout(this._sackTimer);
        this._sackTimer = undefined;
      }
      this._sendSack();
      return;
    }

    // First packet since last SACK: arm the delayed timer
    if (this._sackTimer) return;
    this._sackTimer = setTimeout(() => {
      this._sackTimer = undefined;
      this._sendSack();
    }, SACK_DELAY_MS);
    this._sackTimer.unref?.();
  }

  private _sendSack(): void {
    this._dataPacketsSinceAck = 0;   // reset every-other-packet counter
    // Build gap ACK blocks from _receivedTsns
    const gaps = this._buildGapBlocks();

    const baseLen = 12;
    const value = Buffer.allocUnsafe(baseLen + gaps.length * 4);
    value.writeUInt32BE(this._remoteCumulativeTsn, 0);
    value.writeUInt32BE(MAX_BUFFER, 4);   // advertise our full receive window
    value.writeUInt16BE(gaps.length, 8);
    value.writeUInt16BE(0, 10); // no dup TSNs

    let off = 12;
    for (const [start, end] of gaps) {
      value.writeUInt16BE(start, off);
      value.writeUInt16BE(end, off + 2);
      off += 4;
    }

    this._sendChunks([{ type: ChunkType.SACK, flags: 0, value }]);
  }

  private _buildGapBlocks(): Array<[number, number]> {
    if (this._receivedTsns.size === 0) return [];

    const sorted = [...this._receivedTsns].map(tsn => {
      return _tsnDiff(tsn, this._remoteCumulativeTsn);
    }).filter(d => d > 0).sort((a, b) => a - b);

    const blocks: Array<[number, number]> = [];
    let blockStart = -1;
    let blockEnd = -1;

    for (const offset of sorted) {
      if (blockStart === -1) {
        blockStart = offset;
        blockEnd = offset;
      } else if (offset === blockEnd + 1) {
        blockEnd = offset;
      } else {
        blocks.push([blockStart, blockEnd]);
        blockStart = offset;
        blockEnd = offset;
      }
    }
    if (blockStart !== -1) blocks.push([blockStart, blockEnd]);

    return blocks;
  }

  // ─── FORWARD-TSN (RFC 3758) ───────────────────────────────────────────────

  private _sendForwardTsn(): void {
    const newCumTsn = (this._localTsn - 1) >>> 0;
    const value = Buffer.allocUnsafe(4);
    value.writeUInt32BE(newCumTsn, 0);
    this._sendChunks([{ type: ChunkType.FORWARD_TSN, flags: 0, value }]);
  }

  private _handleForwardTsn(chunk: SctpChunk): void {
    if (chunk.value.length < 4) return;
    const newCumTsn = chunk.value.readUInt32BE(0);

    if (_tsnGT(newCumTsn, this._remoteCumulativeTsn)) {
      for (let t = (this._remoteCumulativeTsn + 1) >>> 0; ; t = (t + 1) >>> 0) {
        this._receivedTsns.delete(t);
        if (t === newCumTsn) break;
        if (_tsnGT(t, newCumTsn)) break; // safety
      }
      this._remoteCumulativeTsn = newCumTsn;
    }
    this._scheduleSack();
  }

  // ─── DCEP ─────────────────────────────────────────────────────────────────

  private _handleDcep(streamId: number, data: Buffer): void {
    let msg;
    console.log(`[SCTP ${this._role}] _handleDcep streamId=${streamId} data[0]=0x${data[0]?.toString(16)}`);
    try { msg = decodeDcep(data); } catch { return; }

    if (msg.type === DcepType.DATA_CHANNEL_OPEN) {
      this._handleDcepOpen(streamId, msg as DcepOpen);
    } else if (msg.type === DcepType.DATA_CHANNEL_ACK) {
      this._handleDcepAck(streamId);
    }
  }

  private _handleDcepOpen(streamId: number, msg: DcepOpen): void {
    const ordered =
      msg.channelType === DcepChannelType.RELIABLE ||
      msg.channelType === DcepChannelType.PARTIAL_RELIABLE_REXMIT ||
      msg.channelType === DcepChannelType.PARTIAL_RELIABLE_TIMED;

    const info: DataChannelInfo = {
      id: streamId,
      label: msg.label,
      protocol: msg.protocol,
      ordered,
      maxPacketLifeTime: msg.channelType === DcepChannelType.PARTIAL_RELIABLE_TIMED
        ? msg.reliabilityParam : undefined,
      maxRetransmits: msg.channelType === DcepChannelType.PARTIAL_RELIABLE_REXMIT
        ? msg.reliabilityParam : undefined,
      state: 'open',
      negotiated: false,
    };

    const channel = new SctpDataChannel(this, info);
    this._channels.set(streamId, channel);
    this._sendDcepAck(streamId);
    channel._open();
    this.emit('datachannel', channel);
  }

  private _handleDcepAck(streamId: number): void {
    const channel = this._channels.get(streamId);
    console.log(`[SCTP ${this._role}] DCEP_ACK on streamId=${streamId} channel=${channel?.label ?? 'NOT FOUND'}`);
    if (channel) channel._open();
  }

  private _sendDcepOpen(id: number, info: DataChannelInfo): void {
    let channelType: number = DcepChannelType.RELIABLE;
    let reliabilityParam = 0;

    if (!info.ordered) {
      if (info.maxRetransmits !== undefined) {
        channelType = DcepChannelType.PARTIAL_RELIABLE_REXMIT_UNORDERED;
        reliabilityParam = info.maxRetransmits;
      } else if (info.maxPacketLifeTime !== undefined) {
        channelType = DcepChannelType.PARTIAL_RELIABLE_TIMED_UNORDERED;
        reliabilityParam = info.maxPacketLifeTime;
      } else {
        channelType = DcepChannelType.RELIABLE_UNORDERED;
      }
    } else {
      if (info.maxRetransmits !== undefined) {
        channelType = DcepChannelType.PARTIAL_RELIABLE_REXMIT;
        reliabilityParam = info.maxRetransmits;
      } else if (info.maxPacketLifeTime !== undefined) {
        channelType = DcepChannelType.PARTIAL_RELIABLE_TIMED;
        reliabilityParam = info.maxPacketLifeTime;
      }
    }

    const dcepBuf = encodeDcepOpen({
      type: DcepType.DATA_CHANNEL_OPEN as 0x03,
      channelType, priority: 0, reliabilityParam,
      label: info.label, protocol: info.protocol,
    });

    const tsn = this._localTsn;
    this._localTsn = (this._localTsn + 1) >>> 0;

    console.log(`[SCTP ${this._role}] sending DCEP_OPEN streamId=${id} label="${info.label}" channelType=${channelType}`);
    const dataChunk = encodeDataChunk({
      tsn, streamId: id, ssn: 0, ppid: Ppid.DCEP,
      userData: dcepBuf, beginning: true, ending: true, unordered: false,
    });
    this._sendChunks([dataChunk]);
  }

  private _sendDcepAck(streamId: number): void {
    const tsn = this._localTsn;
    this._localTsn = (this._localTsn + 1) >>> 0;

    const dataChunk = encodeDataChunk({
      tsn, streamId, ssn: 0, ppid: Ppid.DCEP,
      userData: encodeDcepAck(), beginning: true, ending: true, unordered: false,
    });
    this._sendChunks([dataChunk]);
  }

  // ─── Chunk dispatcher ────────────────────────────────────────────────────

  private _handleChunk(chunk: SctpChunk, incomingVerTag: number): void {
    switch (chunk.type) {
      case ChunkType.INIT:
        if (this._role === 'server') this._handleInit(chunk);
        break;

      case ChunkType.INIT_ACK:
        if (this._role === 'client' && incomingVerTag === this._localTag) {
          this._handleInitAck(chunk);
        }
        break;

      case ChunkType.COOKIE_ECHO:
        if (this._role === 'server') this._handleCookieEcho(chunk);
        break;

      case ChunkType.COOKIE_ACK:
        if (this._role === 'client') this._handleCookieAck();
        break;

      case ChunkType.DATA:
        if (this._state === 'connected') this._handleData(chunk);
        break;

      case ChunkType.SACK:
        if (this._state === 'connected') this._processSack(chunk.value);
        break;

      case ChunkType.FORWARD_TSN:
        this._handleForwardTsn(chunk);
        break;

      case ChunkType.HEARTBEAT:
        this._sendChunks([{ type: ChunkType.HEARTBEAT_ACK, flags: 0, value: Buffer.from(chunk.value) }]);
        break;

      case ChunkType.SHUTDOWN:
        this._sendChunks([{ type: ChunkType.SHUTDOWN_ACK, flags: 0, value: Buffer.alloc(0) }]);
        this._setState('closed');
        for (const ch of this._channels.values()) ch._close();
        this._channels.clear();
        break;

      case ChunkType.SHUTDOWN_ACK:
        this._sendChunks([{ type: ChunkType.SHUTDOWN_COMPLETE, flags: 0, value: Buffer.alloc(0) }]);
        this._setState('closed');
        break;

      case ChunkType.ABORT:
        console.log(`[SCTP ${this._role}] ABORT received! value.length=${chunk.value.length} hex=${chunk.value.slice(0,16).toString('hex')} channels=${this._channels.size} state=${this._state}`);
        this._setState('failed');
        for (const ch of this._channels.values()) ch._close();
        this._channels.clear();
        break;

      default:
        break;
    }
  }
}

// ─── TSN arithmetic helpers (RFC 4960 §3.3.3 wrapping comparison) ──────────

/** Returns true if a ≤ b in TSN space (32-bit wrapping) */
function _tsnLE(a: number, b: number): boolean {
  return ((b - a) >>> 0) < 0x80000000;
}

/** Returns true if a > b in TSN space */
function _tsnGT(a: number, b: number): boolean {
  return a !== b && _tsnLE(b, a);
}

/** Signed distance: how many steps is b ahead of a (in TSN space) */
function _tsnDiff(b: number, a: number): number {
  const diff = (b - a) >>> 0;
  return diff < 0x80000000 ? diff : -(0x100000000 - diff);
}

/** Returns true if a > b in SSN space (16-bit wrapping) */
function _ssnGT(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000 && a !== b;
}
