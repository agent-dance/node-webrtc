import type { RTCIceCandidateInit } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';

/**
 * Buffers ICE candidates received before setRemoteDescription() completes.
 * Flush once the remote description is set.
 */
export class CandidateBuffer {
  private buffer: RTCIceCandidateInit[] = [];
  private flushed = false;
  private flushFn: ((c: RTCIceCandidateInit) => Promise<void>) | null = null;

  enqueue(candidate: RTCIceCandidateInit): void {
    if (this.flushed && this.flushFn) {
      this.flushFn(candidate).catch(console.error);
    } else {
      this.buffer.push(candidate);
    }
  }

  async flush(fn: (c: RTCIceCandidateInit) => Promise<void>): Promise<void> {
    this.flushFn = fn;
    this.flushed = true;
    for (const c of this.buffer) {
      await fn(c);
    }
    this.buffer = [];
  }
}

export type DataChannelMap = Map<string, RTCDataChannel>;
