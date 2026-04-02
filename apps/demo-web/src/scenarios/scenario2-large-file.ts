import { createHash } from 'crypto';
import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager } from '../state/app-state.js';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TOTAL_SIZE = parsePositiveIntEnv(
  'DEMO_SCENARIO2_TOTAL_SIZE',
  500 * 1024 * 1024,
);
// Keep each message ≤ 1 SCTP fragment (MAX_FRAGMENT_SIZE = PMTU-28 = 1172B).
// With 4-byte seq header, usable payload = 1168 bytes.
// Multi-fragment messages stall Flutter's usrsctp reassembly when peerRwnd → 0,
// permanently blocking a_rwnd recovery. Single-fragment messages are delivered
// immediately so Flutter can always free receive buffer space.
const CHUNK_SIZE = parsePositiveIntEnv(
  'DEMO_SCENARIO2_CHUNK_SIZE',
  1168,
);
const HIGH_WATERMARK = parsePositiveIntEnv(
  'DEMO_SCENARIO2_HIGH_WATERMARK',
  4 * 1024 * 1024,
);
const LOW_WATERMARK = parsePositiveIntEnv(
  'DEMO_SCENARIO2_LOW_WATERMARK',
  2 * 1024 * 1024,
);
const SEND_START_DELAY_MS = parsePositiveIntEnv(
  'DEMO_SCENARIO2_START_DELAY_MS',
  0,
);
const SEND_RETRY_MS = parsePositiveIntEnv(
  'DEMO_SCENARIO2_RETRY_MS',
  0,
);
const SEND_BURST_CHUNKS = parsePositiveIntEnv(
  'DEMO_SCENARIO2_BURST_CHUNKS',
  Number.MAX_SAFE_INTEGER,
);
const META_ONLY = process.env.DEMO_SCENARIO2_META_ONLY === '1';
const USE_TEXT_CHUNKS = process.env.DEMO_SCENARIO2_USE_TEXT_CHUNKS === '1';

// Print real-time throughput every N seconds
const SPEED_INTERVAL_MS = 3000;

export interface Scenario2RuntimeOptions {
  totalSize?: number;
  chunkSize?: number;
  ordered?: boolean;
  maxRetransmits?: number;
  descriptorMode?: boolean;
  highWatermark?: number;
  lowWatermark?: number;
  startDelayMs?: number;
  retryMs?: number;
  burstChunks?: number;
  metaOnly?: boolean;
  useTextChunks?: boolean;
}

interface LargeFileMeta {
  type: 'LARGE_FILE_META';
  payload: {
    totalSize: number;
    chunkSize: number;
    transportMode?: 'raw' | 'descriptor';
  };
}

interface ReadyMessage {
  type: 'READY';
}

interface VerifyResult {
  type: 'VERIFY_RESULT';
  payload: { sha256: string; ok: boolean; elapsed_ms: number };
}

interface ChunkMessage {
  type: 'LARGE_FILE_CHUNK';
  payload: {
    seq: number;
    size?: number;
    dataBase64?: string;
  };
}

/** Lazily generate chunk data */
function* generateChunks(totalSize: number, chunkSize: number): Generator<Buffer> {
  let seq = 0;
  let totalSent = 0;
  while (totalSent < totalSize) {
    const size = Math.min(chunkSize, totalSize - totalSent);
    const chunk = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) {
      chunk[i] = (seq * 251 + i * 13) & 0xff;
    }
    yield chunk;
    totalSent += size;
    seq++;
  }
}

export function registerScenario2Channel(
  pc: RTCPeerConnection,
  state: AppStateManager,
  options: Scenario2RuntimeOptions = {},
): void {
  const totalSize = options.totalSize ?? TOTAL_SIZE;
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const highWatermark = options.highWatermark ?? HIGH_WATERMARK;
  const lowWatermark = options.lowWatermark ?? LOW_WATERMARK;
  const startDelayMs = options.startDelayMs ?? SEND_START_DELAY_MS;
  const retryMs = options.retryMs ?? SEND_RETRY_MS;
  const burstChunks = options.burstChunks ?? SEND_BURST_CHUNKS;
  const metaOnly = options.metaOnly ?? META_ONLY;
  const useTextChunks = options.useTextChunks ?? USE_TEXT_CHUNKS;
  const descriptorMode = options.descriptorMode ?? false;

  const channelInit = {
    ordered: options.ordered ?? true,
    ...(options.maxRetransmits !== undefined
      ? { maxRetransmits: options.maxRetransmits }
      : {}),
  };
  const channel: RTCDataChannel = pc.createDataChannel('large-file', channelInit);

  channel.bufferedAmountLowThreshold = lowWatermark;

  let sha256ready = false;
  let sha256hex = '';
  let paused = false;
  let chunkGen: Generator<Buffer> | null = null;
  let seqNum = 0;
  let bytesSent = 0;
  const hasher = createHash('sha256');

  // Real-time speed reporting
  let speedTimer: NodeJS.Timeout | null = null;
  let lastSpeedBytes = 0;
  let lastSpeedTime = 0;

  const startSpeedTimer = (startTime: number): void => {
    lastSpeedBytes = 0;
    lastSpeedTime = startTime;
    speedTimer = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastSpeedTime) / 1000;
      const db = bytesSent - lastSpeedBytes;
      const mbps = db / dt / (1024 * 1024);
      const pct = (bytesSent / totalSize * 100).toFixed(1);
      console.log(
        `[Scenario2] progress=${pct}% sent=${(bytesSent/1024/1024).toFixed(1)}MB ` +
        `speed=${mbps.toFixed(2)}MB/s buffered=${(channel.bufferedAmount/1024).toFixed(0)}KB`,
      );
      lastSpeedBytes = bytesSent;
      lastSpeedTime = now;
      state.updateScenario2({ bytesSent, speedMBps: mbps });
    }, SPEED_INTERVAL_MS);
    speedTimer.unref?.();
  };

  const sendNextChunks = (): void => {
    if (!chunkGen || paused) return;

    let chunksSentThisTick = 0;
    while (true) {
      if (channel.bufferedAmount > highWatermark) {
        paused = true;
        if (retryMs > 0) {
          setTimeout(() => {
            paused = false;
            sendNextChunks();
          }, retryMs);
        }
        return;
      }

      const { value: chunk, done } = chunkGen.next();
      if (done) {
        if (speedTimer) { clearInterval(speedTimer); speedTimer = null; }
        if (!sha256hex) {
          sha256hex = hasher.digest('hex');
          sha256ready = true;
          console.log(`[Scenario2] All chunks sent. Local SHA-256: ${sha256hex}`);
          state.updateScenario2({ sha256Local: sha256hex });
        }
        channel.send(JSON.stringify({ type: 'EOF_MARKER', payload: { sha256: sha256hex } }));
        state.updateScenario2({ bytesSent: totalSize });
        return;
      }

      hasher.update(chunk);

      if (descriptorMode) {
        const msg: ChunkMessage = {
          type: 'LARGE_FILE_CHUNK',
          payload: {
            seq: seqNum,
            size: chunk.length,
          },
        };
        channel.send(JSON.stringify(msg));
      } else if (useTextChunks) {
        const msg: ChunkMessage = {
          type: 'LARGE_FILE_CHUNK',
          payload: {
            seq: seqNum,
            dataBase64: chunk.toString('base64'),
          },
        };
        channel.send(JSON.stringify(msg));
      } else {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(seqNum, 0);
        channel.send(Buffer.concat([header, chunk]));
      }

      seqNum++;
      bytesSent += chunk.length;
      chunksSentThisTick++;

      if (chunksSentThisTick >= burstChunks) {
        setTimeout(sendNextChunks, retryMs);
        return;
      }
    }
  };

  channel.on('bufferedamountlow', () => {
    if (paused) {
      paused = false;
      sendNextChunks();
    }
  });

  channel.on('open', () => {
    console.log('[Scenario2] Channel open, sending meta');
    state.updateScenario2({
      totalBytes: totalSize,
      bytesSent: 0,
      startTime: Date.now(),
      endTime: null,
      sha256Local: '',
      sha256Remote: '',
      verified: null,
      speedMBps: null,
    });

    const meta: LargeFileMeta = {
      type: 'LARGE_FILE_META',
      payload: {
        totalSize,
        chunkSize,
        transportMode: descriptorMode ? 'descriptor' : 'raw',
      },
    };
    channel.send(JSON.stringify(meta));
    console.log('[Scenario2] META sent, waiting for READY');
  });

  channel.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as ReadyMessage | VerifyResult;

      if (msg.type === 'READY') {
        console.log('[Scenario2] Received READY, starting transfer');
        if (metaOnly) {
          return;
        }
        chunkGen = generateChunks(totalSize, chunkSize);
        sha256ready = false;
        sha256hex = '';
        bytesSent = 0;
        seqNum = 0;

        startSpeedTimer(Date.now());
        if (startDelayMs > 0) {
          setTimeout(sendNextChunks, startDelayMs);
        } else {
          sendNextChunks();
        }
      } else if (msg.type === 'VERIFY_RESULT') {
        const { sha256: remoteHash, ok, elapsed_ms } = msg.payload;
        const speedMBps = totalSize / (1024 * 1024) / (elapsed_ms / 1000);
        console.log(
          `[Scenario2] Verify: ok=${ok}, avg_speed=${speedMBps.toFixed(2)} MB/s, ` +
          `remote_sha256=${remoteHash}`,
        );
        void sha256ready;
        state.updateScenario2({
          sha256Remote: remoteHash,
          verified: ok,
          endTime: Date.now(),
          speedMBps,
        });
      }
    } catch {
      // ignore binary
    }
  });

  channel.on('error', (err) => {
    console.error('[Scenario2] Channel error:', err);
  });
}
