import * as crypto from 'node:crypto';
import type * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  AttributeType,
  MessageClass,
  MessageMethod,
  createBindingRequest,
  decodeMessage,
  encodeMessage,
  encodeUsername,
  encodePriority,
  encodeUseCandidate,
  encodeIceControlling,
  encodeIceControlled,
  computeMessageIntegrity,
  verifyMessageIntegrity,
  decodeXorMappedAddress,
  encodeXorMappedAddress,
  isStunMessage,
  generateTransactionId,
  encodeErrorCode,
  decodeUsername,
  decodePriority,
} from '@agentdance/node-webrtc-stun';
import type { StunMessage, StunAttribute } from '@agentdance/node-webrtc-stun';
import {
  computeFingerprint,
} from '@agentdance/node-webrtc-stun';
import {
  IceAgentState,
  IceConnectionState,
  CandidatePairState,
} from './types.js';
import type {
  CandidatePair,
  IceAgentOptions,
  IceCandidate,
  IceParameters,
  IceRole,
} from './types.js';
import {
  generateUfrag,
  generatePassword,
  computeFoundation,
  computePriority,
} from './candidate.js';
import { gatherHostCandidates, gatherSrflxCandidate } from './gather.js';
import { UdpTransport } from './transport.js';
import {
  formCandidatePairs,
  unfreezeInitialPairs,
  getOrCreatePair,
  findPairByAddresses,
} from './checklist.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const KEEPALIVE_INTERVAL_MS = 15_000;
const CHECK_INTERVAL_MS = 20;
const CONNECT_TIMEOUT_MS = 30_000;

// ─── IceAgent event type overloads ───────────────────────────────────────────
export declare interface IceAgent {
  on(event: 'gathering-state', listener: (state: IceAgentState) => void): this;
  on(
    event: 'connection-state',
    listener: (state: IceConnectionState) => void,
  ): this;
  on(
    event: 'local-candidate',
    listener: (candidate: IceCandidate) => void,
  ): this;
  on(event: 'gathering-complete', listener: () => void): this;
  on(event: 'connected', listener: (pair: CandidatePair) => void): this;
  on(
    event: 'data',
    listener: (
      data: Buffer,
      rinfo: { address: string; port: number },
    ) => void,
  ): this;
}

interface PendingEntry {
  pair: CandidatePair;
  signedBuf: Buffer;
  useCandidate: boolean;
  timers: NodeJS.Timeout[];
}

// ─── IceAgent ────────────────────────────────────────────────────────────────
export class IceAgent extends EventEmitter {
  readonly localParameters: IceParameters;

  private _role: IceRole;
  private readonly _tiebreaker: bigint;
  private readonly _nomination: 'regular' | 'aggressive';

  private _gatheringState: IceAgentState = IceAgentState.New;
  private _connectionState: IceConnectionState = IceConnectionState.New;

  private _localCandidates: IceCandidate[] = [];
  private _remoteCandidates: IceCandidate[] = [];
  private _remoteParameters: IceParameters | undefined;

  private _candidatePairs: CandidatePair[] = [];
  private _nomineePair: CandidatePair | undefined;

  private _transport: UdpTransport | undefined;
  private _checkInterval: NodeJS.Timeout | undefined;
  private _keepAliveTimer: NodeJS.Timeout | undefined;
  private _failTimer: NodeJS.Timeout | undefined;

  // txId hex → pending entry
  private _pending = new Map<string, PendingEntry>();
  private _remoteGatheringComplete = false;

  private _connectResolve: ((pair: CandidatePair) => void) | undefined;
  private _connectReject: ((err: Error) => void) | undefined;

  private readonly _portRange: { min: number; max: number } | undefined;
  private readonly _stunServers: Array<{ host: string; port: number }>;

  constructor(options: IceAgentOptions = {}) {
    super();

    this._role = options.role ?? 'controlling';
    this._tiebreaker =
      options.tiebreaker ??
      BigInt('0x' + crypto.randomBytes(8).toString('hex'));
    this._nomination = options.nomination ?? 'regular';
    this._portRange = options.portRange;
    this._stunServers = options.stunServers ?? [];

    // Build IceParameters carefully to avoid exactOptionalPropertyTypes issues
    const params: IceParameters = {
      usernameFragment: options.ufrag ?? generateUfrag(),
      password: options.password ?? generatePassword(),
    };
    if (options.lite !== undefined) {
      params.iceLite = options.lite;
    }
    this.localParameters = params;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async gather(): Promise<void> {
    if (this._gatheringState !== IceAgentState.New) return;

    this._setGatheringState(IceAgentState.Gathering);

    this._transport = new UdpTransport();
    await this._transport.bind(this._pickPort(), '0.0.0.0');

    const port = this._transport.localPort;

    // Host candidates from all local interfaces (loopback + physical + virtual)
    // gatherHostCandidates now includes loopback with highest localPref so that
    // same-machine pairs (loopback↔loopback) get the highest pair priority.
    const hostCandidates = await gatherHostCandidates(port, 1, 'udp');

    for (const c of hostCandidates) {
      this._addLocalCandidate(c);
    }

    // srflx via STUN servers
    if (this._stunServers.length > 0) {
      const rawSocket = (
        this._transport as unknown as { _socket?: dgram.Socket }
      )._socket;
      if (rawSocket) {
        for (const server of this._stunServers) {
          for (const local of hostCandidates) {
            const srflx = await gatherSrflxCandidate(rawSocket, local, server);
            if (srflx) this._addLocalCandidate(srflx);
          }
        }
      }
    }

    // Wire packet demux
    this._transport.on('stun', (buf, rinfo) => {
      this._handleStunPacket(buf, rinfo);
    });
    this._transport.on('rtp', (buf, rinfo) => {
      this.emit('data', buf, { address: rinfo.address, port: rinfo.port });
    });
    // Relay DTLS packets to the upper layer (PeerInternals wires to DtlsTransport)
    this._transport.on('dtls', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
      this.emit('data', buf, { address: rinfo.address, port: rinfo.port });
    });
    // Also relay unknown packets as data (e.g. plain buffers in tests)
    this._transport.on(
      'unknown',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (...args: any[]) => {
        const buf = args[0] as Buffer;
        const rinfo = args[1] as dgram.RemoteInfo;
        this.emit('data', buf, { address: rinfo.address, port: rinfo.port });
      },
    );

    this._setGatheringState(IceAgentState.Complete);
    this.emit('gathering-complete');
  }

  setRemoteParameters(params: IceParameters): void {
    this._remoteParameters = params;
  }

  addRemoteCandidate(candidate: IceCandidate): void {
    // ts-rtc uses UDP-only transport; ignore non-UDP remote candidates
    if (candidate.transport !== 'udp') return;
    // ts-rtc binds a udp4 socket; IPv6 candidates will silently fail — skip them
    if (candidate.address.includes(':')) return;
    this._remoteCandidates.push(candidate);
    if (
      this._connectionState === IceConnectionState.Checking ||
      this._connectionState === IceConnectionState.Connected ||
      this._connectionState === IceConnectionState.Failed
    ) {
      // Re-enter checking if we previously failed with no candidates (trickle ICE timing)
      if (this._connectionState === IceConnectionState.Failed && !this._nomineePair) {
        this._setConnectionState(IceConnectionState.Checking);
        // Restart checks
        this._checkInterval = setInterval(() => { this._tick(); }, CHECK_INTERVAL_MS);
      }
      this._formPairsForRemote(candidate);
    }
  }

  remoteGatheringComplete(): void {
    this._remoteGatheringComplete = true;
    // Now that we know all remote candidates, check if we already failed
    if (this._connectionState === IceConnectionState.Checking) {
      this._checkAllFailed();
    }
  }

  async connect(): Promise<CandidatePair> {
    if (!this._transport) {
      throw new Error('Must call gather() before connect()');
    }
    if (!this._remoteParameters) {
      throw new Error('Must call setRemoteParameters() before connect()');
    }
    if (this._connectionState !== IceConnectionState.New) {
      throw new Error('connect() already called');
    }

    this._setConnectionState(IceConnectionState.Checking);

    this._candidatePairs = formCandidatePairs(
      this._localCandidates,
      this._remoteCandidates,
      this._role,
    );
    unfreezeInitialPairs(this._candidatePairs);

    console.log(`[ICE] connect(): formed ${this._candidatePairs.length} pairs`);
    for (const p of this._candidatePairs) {
      console.log(`[ICE]   pair ${p.local.address}:${p.local.port} -> ${p.remote.address}:${p.remote.port} state=${p.state} prio=${p.priority}`);
    }

    return new Promise<CandidatePair>((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      this._checkInterval = setInterval(() => {
        this._tick();
      }, CHECK_INTERVAL_MS);

      const failTimer = setTimeout(() => {
        if (this._connectionState === IceConnectionState.Checking) {
          this._setConnectionState(IceConnectionState.Failed);
          this._stopChecks();
          const rej = this._connectReject;
          this._connectReject = undefined;
          this._connectResolve = undefined;
          rej?.(new Error('ICE connection timed out'));
        }
      }, CONNECT_TIMEOUT_MS);
      failTimer.unref?.();
      this._failTimer = failTimer;
    });
  }

  send(data: Buffer): void {
    if (!this._transport) {
      throw new Error('No nominated pair – not yet connected');
    }
    // Use nominated pair if available; otherwise fall back to the best valid
    // pair during the window between ICE success and pair nomination (e.g. when
    // the remote sends DTLS data before our USE-CANDIDATE response arrives).
    const pair =
      this._nomineePair ??
      this._candidatePairs.find((p) => p.valid) ??
      this._candidatePairs.find((p) => p.state === CandidatePairState.Succeeded);
    if (!pair) {
      throw new Error('No nominated pair – not yet connected');
    }
    const { address, port } = pair.remote;
    this._transport.send(data, port, address).catch(() => {});
  }

  async restart(): Promise<void> {
    this._stopChecks();
    this._stopKeepAlive();
    this._clearFailTimer();
    this._cancelAllPending();

    (this.localParameters as { usernameFragment: string }).usernameFragment =
      generateUfrag();
    (this.localParameters as { password: string }).password = generatePassword();

    this._localCandidates = [];
    this._remoteCandidates = [];
    this._candidatePairs = [];
    this._nomineePair = undefined;
    this._gatheringState = IceAgentState.New;
    this._connectionState = IceConnectionState.New;

    if (this._transport) {
      this._transport.close();
      this._transport = undefined;
    }

    await this.gather();
  }

  close(): void {
    this._stopChecks();
    this._stopKeepAlive();
    this._clearFailTimer();
    this._cancelAllPending();

    if (this._transport) {
      this._transport.close();
      this._transport = undefined;
    }

    this._setConnectionState(IceConnectionState.Closed);
    this._setGatheringState(IceAgentState.Closed);
  }

  get connectionState(): IceConnectionState {
    return this._connectionState;
  }

  getLocalCandidates(): IceCandidate[] {
    return [...this._localCandidates];
  }

  getSelectedPair(): CandidatePair | undefined {
    return this._nomineePair;
  }

  // ─── Private: state setters ────────────────────────────────────────────────

  private _pickPort(): number {
    if (this._portRange) {
      return (
        this._portRange.min +
        Math.floor(
          Math.random() * (this._portRange.max - this._portRange.min),
        )
      );
    }
    return 0;
  }

  private _addLocalCandidate(c: IceCandidate): void {
    this._localCandidates.push(c);
    this.emit('local-candidate', c);
  }

  private _setGatheringState(s: IceAgentState): void {
    if (this._gatheringState === s) return;
    this._gatheringState = s;
    this.emit('gathering-state', s);
  }

  private _setConnectionState(s: IceConnectionState): void {
    if (this._connectionState === s) return;
    this._connectionState = s;
    this.emit('connection-state', s);
  }

  // ─── Connectivity check scheduling ────────────────────────────────────────

  private _tick(): void {
    // Pick next Waiting pair; if none, unfreeze the highest-priority Frozen pair
    // (RFC 8445 §6.1.4.2 — must keep making progress even when no Waiting pairs)
    let next = this._candidatePairs.find(
      (p) => p.state === CandidatePairState.Waiting,
    );
    if (!next) {
      const frozen = this._candidatePairs.find(
        (p) => p.state === CandidatePairState.Frozen,
      );
      if (frozen) {
        frozen.state = CandidatePairState.Waiting;
        next = frozen;
      }
    }
    if (next) {
      next.state = CandidatePairState.InProgress;
      next.retransmitCount = 0;
      const aggressive =
        this._role === 'controlling' && this._nomination === 'aggressive';
      this._doCheck(next, aggressive);
    }

    this._checkAllFailed();
  }

  private _doCheck(pair: CandidatePair, useCandidate: boolean): void {
    if (!this._transport || !this._remoteParameters) return;

    const txId = generateTransactionId();
    const txIdHex = txId.toString('hex');

    const signedBuf = this._buildSignedRequest(txId, pair, useCandidate);

    // Retransmit schedule: send at t=0, 200ms, 600ms, 1400ms; timeout at 3800ms
    const timers: NodeJS.Timeout[] = [];
    const retransmitDelays = [200, 600, 1400];

    // Send immediately
    this._sendBuf(signedBuf, pair.remote.address, pair.remote.port);

    for (const delay of retransmitDelays) {
      const t = setTimeout(() => {
        if (this._pending.has(txIdHex)) {
          this._sendBuf(signedBuf, pair.remote.address, pair.remote.port);
        }
      }, delay);
      t.unref?.();
      timers.push(t);
    }

    // Final timeout
    const finalTimer = setTimeout(() => {
      if (this._pending.has(txIdHex)) {
        this._pending.delete(txIdHex);
        this._onCheckTimeout(pair);
      }
    }, 3800);
    finalTimer.unref?.();
    timers.push(finalTimer);

    this._pending.set(txIdHex, { pair, signedBuf, useCandidate, timers });
  }

  private _sendBuf(buf: Buffer, address: string, port: number): void {
    this._transport?.send(buf, port, address).catch(() => {});
  }

  private _buildSignedRequest(
    txId: Buffer,
    pair: CandidatePair,
    useCandidate: boolean,
  ): Buffer {
    const remoteParams = this._remoteParameters!;
    const req = createBindingRequest(txId);

    req.attributes.push({
      type: AttributeType.Username,
      value: encodeUsername(
        `${remoteParams.usernameFragment}:${this.localParameters.usernameFragment}`,
      ),
    });

    const prflxPriority = computePriority('prflx', 65535, pair.local.component);
    req.attributes.push({
      type: AttributeType.Priority,
      value: encodePriority(prflxPriority),
    });

    if (useCandidate) {
      req.attributes.push({
        type: AttributeType.UseCandidate,
        value: encodeUseCandidate(),
      });
    }

    if (this._role === 'controlling') {
      req.attributes.push({
        type: AttributeType.IceControlling,
        value: encodeIceControlling(this._tiebreaker),
      });
    } else {
      req.attributes.push({
        type: AttributeType.IceControlled,
        value: encodeIceControlled(this._tiebreaker),
      });
    }

    return this._appendMIAndFP(encodeMessage(req), remoteParams.password);
  }

  /** Append MESSAGE-INTEGRITY + FINGERPRINT to an already-encoded STUN buffer
   *  (RFC 5389 §15.4 + §15.5 — both required for ICE checks per RFC 8445) */
  private _appendMIAndFP(partialBuf: Buffer, password: string): Buffer {
    // Step 1: compute MI with length field reflecting MI TLV (24 bytes)
    const withMiLen = Buffer.from(partialBuf);
    withMiLen.writeUInt16BE(partialBuf.readUInt16BE(2) + 24, 2);

    const key = Buffer.from(password, 'utf8');
    const hmac = computeMessageIntegrity(withMiLen, key);

    const miTlv = Buffer.alloc(24);
    miTlv.writeUInt16BE(AttributeType.MessageIntegrity, 0);
    miTlv.writeUInt16BE(20, 2);
    hmac.copy(miTlv, 4);

    // Append MESSAGE-INTEGRITY
    const withMi = Buffer.concat([partialBuf, miTlv]);
    withMi.writeUInt16BE(partialBuf.readUInt16BE(2) + miTlv.length, 2);

    // Step 2: append FINGERPRINT (RFC 5389 §15.5)
    const fpTlvSize = 8; // 2 type + 2 len + 4 value
    const withFpLen = Buffer.from(withMi);
    withFpLen.writeUInt16BE(withMi.readUInt16BE(2) + fpTlvSize, 2);
    const crc = computeFingerprint(withFpLen);

    const fpTlv = Buffer.alloc(fpTlvSize);
    fpTlv.writeUInt16BE(AttributeType.Fingerprint, 0);
    fpTlv.writeUInt16BE(4, 2);
    fpTlv.writeUInt32BE(crc, 4);

    const result = Buffer.concat([withMi, fpTlv]);
    result.writeUInt16BE(withMi.readUInt16BE(2) + fpTlvSize, 2);
    return result;
  }

  // ─── Response handling ────────────────────────────────────────────────────

  private _onStunResponse(msg: StunMessage): void {
    const txIdHex = msg.transactionId.toString('hex');
    const entry = this._pending.get(txIdHex);
    if (!entry) {
      console.log(`[ICE] stun response txId=${txIdHex.slice(0,8)} — no pending entry (stale?)`);
      return;
    }

    this._pending.delete(txIdHex);
    for (const t of entry.timers) clearTimeout(t);

    const { pair, useCandidate } = entry;

    if (msg.messageClass === MessageClass.ErrorResponse) {
      const errAttr = msg.attributes.find((a: StunAttribute) => a.type === 0x0009);
      const errCode = errAttr ? errAttr.value.readUInt8(3) + (errAttr.value.readUInt8(2) & 0x7) * 100 : 0;
      console.log(`[ICE] error response for ${pair.local.address} -> ${pair.remote.address}:${pair.remote.port} code=${errCode}`);
      pair.state = CandidatePairState.Failed;
      this._checkAllFailed();
      return;
    }

    if (msg.messageClass !== MessageClass.SuccessResponse) return;

    pair.state = CandidatePairState.Succeeded;
    pair.valid = true;
    pair.lastBindingResponseReceived = Date.now();
    console.log(`[ICE] success: ${pair.local.address}:${pair.local.port} -> ${pair.remote.address}:${pair.remote.port}`);

    // RFC 8445 §7.2.5.2.1 – discover local peer-reflexive candidate
    // The XOR-MAPPED-ADDRESS tells us our own address as seen by the remote.
    // If it differs from any known local candidate, add a prflx local candidate.
    const xorAttr = msg.attributes.find(
      (a: StunAttribute) => a.type === AttributeType.XorMappedAddress,
    );
    if (xorAttr) {
      try {
        const mapped = decodeXorMappedAddress(xorAttr.value, msg.transactionId);
        const alreadyKnown = this._localCandidates.some(
          (c) => c.address === mapped.address && c.port === mapped.port,
        );
        if (!alreadyKnown) {
          const base = pair.local;
          const prflxPriority = computePriority('prflx', 65535, base.component);
          const prflx: IceCandidate = {
            foundation: computeFoundation('prflx', mapped.address, 'udp'),
            component: base.component,
            transport: 'udp',
            priority: prflxPriority,
            address: mapped.address,
            port: mapped.port,
            type: 'prflx',
          };
          this._localCandidates.push(prflx);
          // Update the pair to use the prflx local candidate
          pair.local = prflx;
        }
      } catch {
        // ignore decode errors
      }
    }

    this._handlePairSucceeded(pair, useCandidate);
  }

  private _handlePairSucceeded(
    pair: CandidatePair,
    usedCandidateFlag: boolean,
  ): void {
    if (this._role === 'controlling') {
      if (
        this._nomination === 'aggressive' ||
        usedCandidateFlag ||
        pair.nominateOnSuccess
      ) {
        this._nominatePair(pair);
      } else if (!this._nomineePair) {
        // Regular nomination: immediately re-send with USE-CANDIDATE.
        // We must NOT use setImmediate here — the 20ms _tick() timer can
        // race and steal this pair's Waiting state before the re-check fires,
        // sending a normal check (without USE-CANDIDATE) instead.
        pair.nominateOnSuccess = true;
        pair.state = CandidatePairState.InProgress;
        pair.retransmitCount = 0;
        this._doCheck(pair, true);
      }
    } else {
      // Controlled: nominate if USE-CANDIDATE was set on this pair
      if (pair.nominateOnSuccess) {
        this._nominatePair(pair);
      }
    }
  }

  private _onCheckTimeout(pair: CandidatePair): void {
    console.log(`[ICE] timeout: ${pair.local.address}:${pair.local.port} -> ${pair.remote.address}:${pair.remote.port}`);
    if (
      pair.state !== CandidatePairState.Succeeded &&
      pair.state !== CandidatePairState.Failed
    ) {
      pair.state = CandidatePairState.Failed;
    }
    this._checkAllFailed();
  }

  // ─── Binding request handling ─────────────────────────────────────────────

  private _onBindingRequest(
    rawBuf: Buffer,
    msg: StunMessage,
    rinfo: dgram.RemoteInfo,
  ): void {
    if (!this._transport) return;

    // Verify MESSAGE-INTEGRITY
    if (
      !verifyMessageIntegrity(
        rawBuf,
        Buffer.from(this.localParameters.password, 'utf8'),
      )
    ) {
      this._sendError(msg, 401, 'Unauthorized', rinfo);
      return;
    }

    // Verify USERNAME
    const usernameAttr = msg.attributes.find(
      (a: StunAttribute) => a.type === AttributeType.Username,
    );
    if (!usernameAttr) {
      this._sendError(msg, 400, 'Bad Request', rinfo);
      return;
    }
    const username = decodeUsername(usernameAttr.value);
    const colonIdx = username.indexOf(':');
    const localUfragInMsg =
      colonIdx >= 0 ? username.slice(0, colonIdx) : username;
    if (localUfragInMsg !== this.localParameters.usernameFragment) {
      this._sendError(msg, 401, 'Unauthorized', rinfo);
      return;
    }

    const useCandidate = msg.attributes.some(
      (a: StunAttribute) => a.type === AttributeType.UseCandidate,
    );

    // Send success response
    this._sendBindingResponse(msg, rinfo);

    // Find best local candidate
    const localPort = this._transport.localPort;
    const localCandidate =
      this._localCandidates.find((c) => c.port === localPort) ??
      this._localCandidates[0];

    if (!localCandidate) return;

    // Find or create remote candidate
    let remoteCandidate = this._remoteCandidates.find(
      (c) => c.address === rinfo.address && c.port === rinfo.port,
    );

    if (!remoteCandidate) {
      const priorityAttr = msg.attributes.find(
        (a: StunAttribute) => a.type === AttributeType.Priority,
      );
      const prflxPriority = priorityAttr
        ? decodePriority(priorityAttr.value)
        : computePriority('prflx', 65535, localCandidate.component);

      remoteCandidate = {
        foundation: computeFoundation('prflx', rinfo.address, 'udp'),
        component: localCandidate.component,
        transport: 'udp',
        priority: prflxPriority,
        address: rinfo.address,
        port: rinfo.port,
        type: 'prflx',
      };
      this._remoteCandidates.push(remoteCandidate);
    }

    const { pair, isNew } = getOrCreatePair(
      this._candidatePairs,
      localCandidate,
      remoteCandidate,
      this._role,
    );

    if (isNew) {
      this._candidatePairs.push(pair);
      this._sortPairs();
    }

    pair.lastBindingRequestReceived = Date.now();

    if (this._role === 'controlled' && useCandidate) {
      pair.nominateOnSuccess = true;
    }

    // Triggered check — execute synchronously to avoid _tick() race.
    if (
      pair.state !== CandidatePairState.InProgress &&
      pair.state !== CandidatePairState.Succeeded
    ) {
      pair.state = CandidatePairState.InProgress;
      pair.retransmitCount = 0;
      this._doCheck(pair, false);
    }

    // Controlled: nominate immediately if USE-CANDIDATE and pair already succeeded
    if (
      this._role === 'controlled' &&
      useCandidate &&
      pair.state === CandidatePairState.Succeeded
    ) {
      this._nominatePair(pair);
    }
  }

  private _sendBindingResponse(
    msg: StunMessage,
    rinfo: dgram.RemoteInfo,
  ): void {
    if (!this._transport) return;

    const xorValue = encodeXorMappedAddress(
      { family: 4, port: rinfo.port, address: rinfo.address },
      msg.transactionId,
    );

    const resp: StunMessage = {
      messageClass: MessageClass.SuccessResponse,
      messageMethod: MessageMethod.Binding,
      transactionId: Buffer.from(msg.transactionId),
      attributes: [{ type: AttributeType.XorMappedAddress, value: xorValue }],
    };

    const partial = encodeMessage(resp);
    const signed = this._appendMIAndFP(partial, this.localParameters.password);
    this._transport.send(signed, rinfo.port, rinfo.address).catch(() => {});
  }

  private _sendError(
    request: StunMessage,
    code: number,
    reason: string,
    rinfo: dgram.RemoteInfo,
  ): void {
    if (!this._transport) return;

    const resp: StunMessage = {
      messageClass: MessageClass.ErrorResponse,
      messageMethod: MessageMethod.Binding,
      transactionId: Buffer.from(request.transactionId),
      attributes: [
        {
          type: AttributeType.ErrorCode,
          value: encodeErrorCode({ code, reason }),
        },
      ],
    };

    this._transport
      .send(encodeMessage(resp), rinfo.port, rinfo.address)
      .catch(() => {});
  }

  // ─── Packet demux ─────────────────────────────────────────────────────────

  private _handleStunPacket(rawBuf: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!isStunMessage(rawBuf)) return;

    let msg: StunMessage;
    try {
      msg = decodeMessage(rawBuf);
    } catch {
      return;
    }

    if (msg.messageMethod !== MessageMethod.Binding) return;

    if (msg.messageClass === MessageClass.Request) {
      this._onBindingRequest(rawBuf, msg, rinfo);
    } else if (
      msg.messageClass === MessageClass.SuccessResponse ||
      msg.messageClass === MessageClass.ErrorResponse
    ) {
      this._onStunResponse(msg);
    }
  }

  // ─── Nomination ───────────────────────────────────────────────────────────

  private _nominatePair(pair: CandidatePair): void {
    if (this._nomineePair) return;

    pair.nominated = true;
    this._nomineePair = pair;

    this._stopChecks();
    this._clearFailTimer();

    this._setConnectionState(IceConnectionState.Connected);
    this.emit('connected', pair);

    const resolve = this._connectResolve;
    this._connectResolve = undefined;
    this._connectReject = undefined;
    resolve?.(pair);

    this._startKeepAlive();
  }

  // ─── All-failed detection ─────────────────────────────────────────────────

  private _checkAllFailed(): void {
    if (this._nomineePair) return;
    if (this._connectionState !== IceConnectionState.Checking) return;

    // Don't fail until we know all remote candidates (trickle ICE)
    if (!this._remoteGatheringComplete) return;

    const hasAlive = this._candidatePairs.some(
      (p) =>
        p.state === CandidatePairState.Waiting ||
        p.state === CandidatePairState.InProgress ||
        p.state === CandidatePairState.Frozen,
    );
    if (!hasAlive && this._pending.size === 0) {
      this._setConnectionState(IceConnectionState.Failed);
      this._stopChecks();
      this._clearFailTimer();

      const reject = this._connectReject;
      this._connectReject = undefined;
      this._connectResolve = undefined;
      reject?.(new Error('All candidate pairs failed'));
    }
  }

  // ─── Timer management ─────────────────────────────────────────────────────

  private _sortPairs(): void {
    this._candidatePairs.sort((a, b) => {
      if (b.priority > a.priority) return 1;
      if (b.priority < a.priority) return -1;
      return 0;
    });
  }

  private _stopChecks(): void {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = undefined;
    }
  }

  private _clearFailTimer(): void {
    if (this._failTimer) {
      clearTimeout(this._failTimer);
      this._failTimer = undefined;
    }
  }

  private _startKeepAlive(): void {
    const timer = setInterval(() => {
      if (this._nomineePair) {
        this._doCheck(this._nomineePair, false);
      }
    }, KEEPALIVE_INTERVAL_MS);
    timer.unref?.();
    this._keepAliveTimer = timer;
  }

  private _stopKeepAlive(): void {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = undefined;
    }
  }

  private _cancelAllPending(): void {
    for (const entry of this._pending.values()) {
      for (const t of entry.timers) clearTimeout(t);
    }
    this._pending.clear();
  }

  private _formPairsForRemote(remote: IceCandidate): void {
    for (const local of this._localCandidates) {
      if (local.component !== remote.component) continue;
      const exists = findPairByAddresses(
        this._candidatePairs,
        local.address,
        local.port,
        remote.address,
        remote.port,
      );
      if (!exists) {
        const { pair } = getOrCreatePair(
          this._candidatePairs,
          local,
          remote,
          this._role,
        );
        this._candidatePairs.push(pair);
      }
    }
    this._sortPairs();
    unfreezeInitialPairs(this._candidatePairs);
  }
}
