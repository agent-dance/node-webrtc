import { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import { CandidateBuffer } from './candidate-buffer.js';
import type { AppStateManager } from '../state/app-state.js';
import type { SignalingClient } from '../server/signaling-client.js';
import {
  registerScenario1Channels,
  type Scenario1RuntimeOptions,
} from '../scenarios/scenario1-multi-file.js';
import {
  registerScenario2Channel,
  type Scenario2RuntimeOptions,
} from '../scenarios/scenario2-large-file.js';
import { registerScenario3Channel } from '../scenarios/scenario3-snake.js';
import { registerScenario4Channel } from '../scenarios/scenario4-video.js';

function getEnabledScenarios(peerId: string): Set<string> {
  const raw = process.env.DEMO_SCENARIOS?.trim();
  if (!raw) {
    void peerId;
    return new Set(['1', '2', '3', '4']);
  }
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export class PeerManager {
  private pc: RTCPeerConnection | null = null;
  private candidateBuffer = new CandidateBuffer();

  constructor(
    private readonly state: AppStateManager,
    private readonly signalingClient: SignalingClient,
  ) {}

  private getScenario1Options(peerId: string): Scenario1RuntimeOptions {
    if (process.platform === 'win32' && peerId === 'flutter-b') {
      return {
        chunkSize: 64 * 1024,
        descriptorMode: true,
        startDelayMs: 500,
        maxBuffered: 64 * 1024,
        burstChunks: 4,
        retryMs: 1,
        sequential: true,
      };
    }
    return {};
  }

  private getScenario2Options(peerId: string): Scenario2RuntimeOptions {
    if (process.platform === 'win32' && peerId === 'flutter-b') {
      return {
        chunkSize: 256 * 1024,
        descriptorMode: true,
        startDelayMs: 500,
        burstChunks: 8,
        retryMs: 0,
        highWatermark: 256 * 1024,
        lowWatermark: 128 * 1024,
      };
    }
    return {};
  }

  /** Called when peer-joined is received (Node.js is always Caller) */
  async startCall(peerId: string): Promise<void> {
    console.log(`[PeerManager] Starting call with peer: ${peerId}`);
    this.state.update({ connectionState: 'connecting', peerId });

    // Local loopback demo — no STUN needed, host candidates are sufficient
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;

    const enabledScenarios = getEnabledScenarios(peerId);
    console.log(
      `[PeerManager] Enabled scenarios: ${[...enabledScenarios].join(', ') || '(none)'}`,
    );

    // Register all scenario channels BEFORE createOffer
    if (enabledScenarios.has('1')) {
      registerScenario1Channels(pc, this.state, this.getScenario1Options(peerId));
    }
    if (enabledScenarios.has('2')) {
      registerScenario2Channel(pc, this.state, this.getScenario2Options(peerId));
    }
    if (enabledScenarios.has('3')) {
      registerScenario3Channel(pc, this.state);
    }
    if (enabledScenarios.has('4')) {
      registerScenario4Channel(pc, this.state);
    }

    pc.on('icecandidate', (candidate) => {
      if (candidate) {
        console.log(`[PeerManager] Local candidate: ${candidate.candidate}`);
        this.signalingClient.send({ type: 'candidate', payload: candidate });
      } else {
        console.log('[PeerManager] ICE gathering complete');
      }
    });

    pc.on('connectionstatechange', () => {
      const cs = pc.connectionState;
      console.log(`[PeerManager] connectionState: ${cs}`);
      this.state.update({ connectionState: cs });
    });

    pc.on('iceconnectionstatechange', () => {
      console.log(`[PeerManager] iceConnectionState: ${pc.iceConnectionState}`);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signalingClient.send({ type: 'offer', payload: offer });
    console.log('[PeerManager] Offer sent');
  }

  async handleAnswer(payload: unknown): Promise<void> {
    if (!this.pc) return;
    const desc = payload as { type: 'answer'; sdp: string };
    await this.pc.setRemoteDescription(desc);
    console.log('[PeerManager] Remote description set (answer)');

    // Flush buffered candidates
    await this.candidateBuffer.flush((c) => this.pc!.addIceCandidate(c));
  }

  async handleOffer(payload: unknown): Promise<void> {
    // Node.js is always the caller; we don't handle incoming offers
    console.warn('[PeerManager] Received offer but Node.js is caller – ignoring');
    void payload;
  }

  handleCandidate(payload: unknown): void {
    const candidate = payload as { candidate: string; sdpMid: string; sdpMLineIndex: number };
    console.log(`[PeerManager] Remote candidate: ${candidate.candidate}`);
    this.candidateBuffer.enqueue(candidate);
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
  }

  getChannel(label: string): RTCDataChannel | undefined {
    // Channels are owned by scenarios; this is a passthrough
    void label;
    return undefined;
  }
}
