import { EventEmitter } from 'events';
import type {
  RTCConfiguration,
  RTCSessionDescriptionInit,
  RTCSessionDescription,
  RTCIceCandidateInit,
  RTCOfferOptions,
  RTCAnswerOptions,
  RTCSignalingState,
  RTCPeerConnectionState,
  RTCIceConnectionState,
  RTCIceGatheringState,
  RTCDataChannelInit,
  RTCRtpTransceiverDirection,
} from './types.js';
import { RTCDataChannel as _RTCDataChannel } from './data-channel.js';
import { RTCRtpTransceiver as _RTCRtpTransceiver } from './rtp-transceiver.js';

export { RTCSessionDescription } from './session-description.js';
export { RTCIceCandidate } from './ice-candidate.js';
export { RTCDataChannel } from './data-channel.js';
export { RTCRtpSender } from './rtp-sender.js';
export { RTCRtpReceiver } from './rtp-receiver.js';
export { RTCRtpTransceiver } from './rtp-transceiver.js';

export * from './types.js';

export declare interface RTCPeerConnection {
  on(event: 'icecandidate', listener: (init: RTCIceCandidateInit | null) => void): this;
  on(event: 'icecandidateerror', listener: (ev: { errorCode: number; errorText: string }) => void): this;
  on(event: 'iceconnectionstatechange', listener: () => void): this;
  on(event: 'icegatheringstatechange', listener: () => void): this;
  on(event: 'connectionstatechange', listener: () => void): this;
  on(event: 'signalingstatechange', listener: () => void): this;
  on(event: 'negotiationneeded', listener: () => void): this;
  on(event: 'datachannel', listener: (channel: import('./data-channel.js').RTCDataChannel) => void): this;
  on(event: 'track', listener: (ev: RTCTrackEvent) => void): this;
}

export interface RTCTrackEvent {
  receiver: import('./rtp-receiver.js').RTCRtpReceiver;
  track: { kind: string };
}

export class RTCPeerConnection extends EventEmitter {
  readonly localDescription: RTCSessionDescription | null = null;
  readonly remoteDescription: RTCSessionDescription | null = null;
  readonly currentLocalDescription: RTCSessionDescription | null = null;
  readonly currentRemoteDescription: RTCSessionDescription | null = null;
  readonly pendingLocalDescription: RTCSessionDescription | null = null;
  readonly pendingRemoteDescription: RTCSessionDescription | null = null;

  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';

  private _config: Required<RTCConfiguration>;
  private _isClosed = false;
  private _transceivers: _RTCRtpTransceiver[] = [];
  private _dataChannels: Map<string, _RTCDataChannel> = new Map();
  private _pendingChannels: _RTCDataChannel[] = [];

  // Protocol stack (initialized lazily)
  private _internals: import('./internal/peer-internals.js').PeerInternals | undefined;

  constructor(config: RTCConfiguration = {}) {
    super();
    this._config = {
      iceServers: config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: config.iceTransportPolicy ?? 'all',
      bundlePolicy: config.bundlePolicy ?? 'max-bundle',
      rtcpMuxPolicy: config.rtcpMuxPolicy ?? 'require',
      iceCandidatePoolSize: config.iceCandidatePoolSize ?? 0,
      certificates: config.certificates ?? [],
    };
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this._assertNotClosed();
    const internals = await this._getOrCreateInternals();
    return internals.createOffer(options ?? {});
  }

  async createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    this._assertNotClosed();
    const internals = await this._getOrCreateInternals();
    return internals.createAnswer(options ?? {});
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this._assertNotClosed();
    const internals = await this._getOrCreateInternals();
    await internals.setLocalDescription(description);
    (this as { localDescription: RTCSessionDescription | null }).localDescription = {
      type: description.type,
      sdp: description.sdp,
    };
    this._updateSignalingState(description.type, 'local');
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this._assertNotClosed();
    const internals = await this._getOrCreateInternals();
    await internals.setRemoteDescription(description);
    (this as { remoteDescription: RTCSessionDescription | null }).remoteDescription = {
      type: description.type,
      sdp: description.sdp,
    };
    this._updateSignalingState(description.type, 'remote');
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    const internals = this._internals;
    if (!internals) return;
    // null or empty candidate string = end-of-candidates signal (RFC 8840 §4.4)
    if (!candidate || !candidate.candidate) {
      internals.iceAgent?.remoteGatheringComplete();
      return;
    }
    await internals.addIceCandidate(candidate);
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): _RTCDataChannel {
    this._assertNotClosed();
    const channel = new _RTCDataChannel(label, init ?? {}, null);
    // Use a unique key: label + id (if specified) + random suffix to avoid collisions
    const key = label + ':' + (init?.id ?? '') + ':' + Math.random().toString(36).slice(2);
    this._dataChannels.set(key, channel);

    if (this._internals?.sctpAssociation?.state === 'connected') {
      // SCTP is ready now — open immediately
      this._internals.openDataChannel(channel);
    } else if (this._internals) {
      // Internals exist but SCTP not ready — hand off to internals pending queue
      this._internals.openDataChannel(channel);
    } else {
      // Internals not yet created — store locally until SCTP is ready
      this._pendingChannels.push(channel);
    }

    // Clean up the map when the channel closes
    channel.on('close', () => {
      this._dataChannels.delete(key);
    });

    return channel;
  }

  addTransceiver(
    kind: 'audio' | 'video',
    init?: { direction?: RTCRtpTransceiverDirection },
  ): _RTCRtpTransceiver {
    this._assertNotClosed();
    const transceiver = new _RTCRtpTransceiver(kind, init?.direction ?? 'sendrecv');
    this._transceivers.push(transceiver);
    this.emit('negotiationneeded');
    return transceiver;
  }

  getTransceivers(): _RTCRtpTransceiver[] {
    return [...this._transceivers];
  }

  getSenders(): import('./rtp-sender.js').RTCRtpSender[] {
    return this._transceivers
      .map((t) => t.sender)
      .filter(Boolean) as import('./rtp-sender.js').RTCRtpSender[];
  }

  getReceivers(): import('./rtp-receiver.js').RTCRtpReceiver[] {
    return this._transceivers
      .map((t) => t.receiver)
      .filter(Boolean) as import('./rtp-receiver.js').RTCRtpReceiver[];
  }

  async getStats(): Promise<import('./stats.js').RTCStatsReport> {
    const { RTCStatsReportImpl } = await import('./stats.js');
    const internals = this._internals;
    if (!internals) return new RTCStatsReportImpl(new Map());
    return internals.getStats();
  }

  close(): void {
    if (this._isClosed) return;
    this._isClosed = true;
    this._internals?.close();
    this._updateConnectionState('closed');
    this.signalingState = 'closed';
  }

  restartIce(): void {
    this._internals?.restartIce();
  }

  private async _getOrCreateInternals(): Promise<import('./internal/peer-internals.js').PeerInternals> {
    if (!this._internals) {
      const { PeerInternals } = await import('./internal/peer-internals.js');
      this._internals = new PeerInternals(this._config, this);
      // Transfer any channels created before internals existed
      for (const channel of this._pendingChannels) {
        this._internals.openDataChannel(channel);
      }
      this._pendingChannels = [];
    }
    return this._internals;
  }

  private _assertNotClosed(): void {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
  }

  private _updateSignalingState(type: string, side: 'local' | 'remote'): void {
    const prev = this.signalingState;
    let next: RTCSignalingState = prev;

    if (type === 'rollback') {
      next = 'stable';
    } else if (type === 'offer') {
      next = side === 'local' ? 'have-local-offer' : 'have-remote-offer';
    } else if (type === 'answer') {
      next = 'stable';
    } else if (type === 'pranswer') {
      next = side === 'local' ? 'have-local-pranswer' : 'have-remote-pranswer';
    }

    if (next !== prev) {
      this.signalingState = next;
      this.emit('signalingstatechange');
    }
  }

  _updateConnectionState(state: RTCPeerConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.emit('connectionstatechange');
    }
  }

  _updateIceConnectionState(state: RTCIceConnectionState): void {
    if (this.iceConnectionState !== state) {
      this.iceConnectionState = state;
      this.emit('iceconnectionstatechange');
    }
  }

  _updateIceGatheringState(state: RTCIceGatheringState): void {
    if (this.iceGatheringState !== state) {
      this.iceGatheringState = state;
      this.emit('icegatheringstatechange');
    }
  }
}
