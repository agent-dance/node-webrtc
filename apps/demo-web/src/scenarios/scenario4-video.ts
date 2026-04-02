import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager } from '../state/app-state.js';

const WIDTH = 320;
const HEIGHT = 240;
const FRAME_INTERVAL_MS = 1000 / 30; // ~33ms for 30fps
const MAX_BUFFERED = 32 * 1024; // Parametric frame headers should stay tiny

/** Generate a frame header: [4B frameId][4B w][4B h][8B ts_ms] = 20 bytes */
function buildFrameHeader(frameId: number, tsMs: bigint): Buffer {
  const header = Buffer.allocUnsafe(20);
  header.writeUInt32BE(frameId, 0);
  header.writeUInt32BE(WIDTH, 4);
  header.writeUInt32BE(HEIGHT, 8);
  header.writeBigInt64BE(tsMs, 12);
  return header;
}

export function registerScenario4Channel(
  pc: RTCPeerConnection,
  state: AppStateManager,
): void {
  const channel: RTCDataChannel = pc.createDataChannel('video-stream', {
    ordered: false,
    maxRetransmits: 0,
  });

  let frameId = 0;
  let frameTimer: NodeJS.Timeout | null = null;
  let framesSent = 0;
  let framesDropped = 0;
  let fpsCounter = 0;
  let fpsTimer: NodeJS.Timeout | null = null;

  channel.on('open', () => {
    console.log('[Scenario4] Video channel open, starting stream');
    state.updateScenario4({ startTime: Date.now(), framesSent: 0, framesDropped: 0, fps: 0 });

    fpsTimer = setInterval(() => {
      state.updateScenario4({ fps: fpsCounter });
      fpsCounter = 0;
    }, 1000);

    frameTimer = setInterval(() => {
      // Drop frame if buffer is too full
      if (channel.bufferedAmount > MAX_BUFFERED) {
        framesDropped++;
        state.updateScenario4({ framesDropped });
        return;
      }

      const tsMs = BigInt(Date.now());
      // Send a compact frame header only. Flutter synthesizes the same
      // deterministic HSV animation locally from frameId/size/timestamp, which
      // preserves the visual design without fragmenting 300 KB RGBA payloads on
      // Windows DataChannel transports.
      const frame = buildFrameHeader(frameId, tsMs);
      channel.send(frame);
      frameId++;
      framesSent++;
      fpsCounter++;
      state.updateScenario4({ framesSent });
    }, FRAME_INTERVAL_MS);
  });

  channel.on('close', () => {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (fpsTimer) { clearInterval(fpsTimer); fpsTimer = null; }
    console.log('[Scenario4] Video channel closed');
  });

  channel.on('error', (err) => {
    console.error('[Scenario4] Error:', err);
  });
}
