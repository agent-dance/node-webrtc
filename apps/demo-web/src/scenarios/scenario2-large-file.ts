import { createHash } from 'crypto';
import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager } from '../state/app-state.js';

const TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB
// Keep each message ≤ 1 SCTP fragment (MAX_FRAGMENT_SIZE = PMTU-28 = 1172B).
// With 4-byte seq header, usable payload = 1168 bytes.
// Multi-fragment messages stall Flutter's usrsctp reassembly when peerRwnd → 0,
// permanently blocking a_rwnd recovery. Single-fragment messages are delivered
// immediately so Flutter can always free receive buffer space.
const CHUNK_SIZE = 1168; // 1168 bytes – exactly one SCTP fragment
const HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB – keep pipeline full
const LOW_WATERMARK  = 2 * 1024 * 1024; // resume when bufferedAmount drops below 2 MB

// Print real-time throughput every N seconds
const SPEED_INTERVAL_MS = 3000;

interface LargeFileMeta {
  type: 'LARGE_FILE_META';
  payload: { totalSize: number; chunkSize: number };
}

interface ReadyMessage {
  type: 'READY';
}

interface VerifyResult {
  type: 'VERIFY_RESULT';
  payload: { sha256: string; ok: boolean; elapsed_ms: number };
}

/** Lazily generate chunk data */
function* generateChunks(): Generator<Buffer> {
  let seq = 0;
  let totalSent = 0;
  while (totalSent < TOTAL_SIZE) {
    const size = Math.min(CHUNK_SIZE, TOTAL_SIZE - totalSent);
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
): void {
  const channel: RTCDataChannel = pc.createDataChannel('large-file', { ordered: true });

  channel.bufferedAmountLowThreshold = LOW_WATERMARK;

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
      const pct = (bytesSent / TOTAL_SIZE * 100).toFixed(1);
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

    while (true) {
      if (channel.bufferedAmount > HIGH_WATERMARK) {
        paused = true;
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
        state.updateScenario2({ bytesSent: TOTAL_SIZE });
        return;
      }

      hasher.update(chunk);

      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(seqNum, 0);
      channel.send(Buffer.concat([header, chunk]));

      seqNum++;
      bytesSent += chunk.length;
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
      totalBytes: TOTAL_SIZE,
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
      payload: { totalSize: TOTAL_SIZE, chunkSize: CHUNK_SIZE },
    };
    channel.send(JSON.stringify(meta));
    console.log('[Scenario2] META sent, waiting for READY');
  });

  channel.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as ReadyMessage | VerifyResult;

      if (msg.type === 'READY') {
        console.log('[Scenario2] Received READY, starting transfer');
        chunkGen = generateChunks();
        sha256ready = false;
        sha256hex = '';
        bytesSent = 0;
        seqNum = 0;

        startSpeedTimer(Date.now());
        sendNextChunks();
      } else if (msg.type === 'VERIFY_RESULT') {
        const { sha256: remoteHash, ok, elapsed_ms } = msg.payload;
        const speedMBps = TOTAL_SIZE / (1024 * 1024) / (elapsed_ms / 1000);
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
