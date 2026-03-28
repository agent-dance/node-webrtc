import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager } from '../state/app-state.js';

const WIDTH = 320;
const HEIGHT = 240;
const FRAME_INTERVAL_MS = 1000 / 30; // ~33ms for 30fps
const MAX_BUFFERED = 2 * WIDTH * HEIGHT * 4 + 20; // ~2 raw frames

/** Generate a frame header: [4B frameId][4B w][4B h][8B ts_ms] = 20 bytes */
function buildFrameHeader(frameId: number, tsMs: bigint): Buffer {
  const header = Buffer.allocUnsafe(20);
  header.writeUInt32BE(frameId, 0);
  header.writeUInt32BE(WIDTH, 4);
  header.writeUInt32BE(HEIGHT, 8);
  header.writeBigInt64BE(tsMs, 12);
  return header;
}

/** Generate HSV→RGB spiral animation frame */
function generateFrame(frameId: number): Buffer {
  const pixels = Buffer.allocUnsafe(WIDTH * HEIGHT * 4);
  const hueBase = (frameId * 2) % 360;
  const scanLine = frameId % HEIGHT;

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const idx = (y * WIDTH + x) * 4;

      // HSV hue based on position + frame
      const hue = (hueBase + (x + y) * 0.5) % 360;
      const sat = 0.8;
      // Scanline brightness wave
      const val = y === scanLine ? 1.0 : 0.6 + 0.2 * Math.sin((x + frameId * 3) * 0.05);

      const [r, g, b] = hsvToRgb(hue, sat, val);
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }

  return pixels;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
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
      const header = buildFrameHeader(frameId, tsMs);
      const pixels = generateFrame(frameId);
      const frame = Buffer.concat([header, pixels]);

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
