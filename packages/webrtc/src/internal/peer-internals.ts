/**
 * PeerInternals - The glue layer connecting ICE, DTLS, SRTP, SCTP and SDP
 * for the RTCPeerConnection implementation.
 *
 * Connection flow:
 *   1. createOffer/createAnswer → SDP generation
 *   2. setLocalDescription → start ICE gathering
 *   3. setRemoteDescription → parse remote SDP, set remote ICE params
 *   4. addIceCandidate → feed candidates to ICE agent
 *   5. ICE connects → start DTLS handshake
 *   6. DTLS connects → extract SRTP keying material + start SCTP
 *   7. SCTP connects → DataChannels available
 */

import { EventEmitter } from 'events';
import type {
  RTCConfiguration,
  RTCOfferOptions,
  RTCAnswerOptions,
  RTCSessionDescriptionInit,
  RTCIceCandidateInit,
} from '../types.js';
import type { RTCPeerConnection } from '../peer-connection.js';
import { RTCDataChannel as WebRTCDataChannel } from '../data-channel.js';
import type { RTCDataChannel } from '../data-channel.js';
import { RTCStatsReportImpl } from '../stats.js';
import type { RTCStats } from '../stats.js';

// Types from sub-packages
type IceAgent = import('@agentdance/node-webrtc-ice').IceAgent;
type DtlsTransport = import('@agentdance/node-webrtc-dtls').DtlsTransport;
type DtlsCertificate = import('@agentdance/node-webrtc-dtls').DtlsCertificate;
type SctpAssociation = import('@agentdance/node-webrtc-sctp').SctpAssociation;

export class PeerInternals extends EventEmitter {
  private readonly _pc: RTCPeerConnection;
  private readonly _config: Required<RTCConfiguration>;

  iceAgent: IceAgent | undefined;
  dtlsTransport: DtlsTransport | undefined;
  sctpAssociation: SctpAssociation | undefined;
  localCertificate: DtlsCertificate | undefined;

  private _localSdp: string | undefined;
  private _remoteSdp: string | undefined;
  private _remoteFingerprint: { algorithm: string; value: string } | null = null;
  private _remoteSctpPort: number | null = null;
  private _iceRole: 'controlling' | 'controlled' = 'controlling';
  private _dtlsRole: 'client' | 'server' = 'client';
  private readonly _pendingDataChannels: RTCDataChannel[] = [];
  private readonly _stunServers: Array<{ host: string; port: number }> = [];

  constructor(config: Required<RTCConfiguration>, pc: RTCPeerConnection) {
    super();
    this._config = config;
    this._pc = pc;

    // Parse ICE server URLs
    for (const server of config.iceServers ?? []) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) {
        const match = url.match(/^stun:(.+):(\d+)$/);
        if (match) {
          this._stunServers.push({ host: match[1]!, port: parseInt(match[2]!, 10) });
        }
      }
    }
  }

  async createOffer(_options: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    const { generateSdpOffer } = await import('./sdp-factory.js');
    await this._ensureIceAgent();
    await this._ensureCertificate();
    const sdp = await generateSdpOffer(this.iceAgent!, this._config, this.localCertificate!);
    this._localSdp = sdp;
    return { type: 'offer', sdp };
  }

  async createAnswer(_options: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    const { generateSdpAnswer } = await import('./sdp-factory.js');
    await this._ensureIceAgent();
    await this._ensureCertificate();
    const sdp = await generateSdpAnswer(this.iceAgent!, this._remoteSdp!, this._config, this.localCertificate!);
    this._localSdp = sdp;
    return { type: 'answer', sdp };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this._localSdp = desc.sdp;
    await this._ensureIceAgent();

    if (desc.type === 'offer') {
      this._iceRole = 'controlling';
      this._dtlsRole = 'client';
    } else if (desc.type === 'answer') {
      if (desc.sdp.includes('a=setup:passive')) {
        this._dtlsRole = 'server';
      }
    }

    this._pc._updateIceGatheringState('gathering');
    await this.iceAgent!.gather();

    // If remote description already set, start connectivity now (answerer case)
    if (this._remoteSdp && desc.type !== 'offer') {
      this._startConnectivity(this._remoteFingerprint, this._remoteSctpPort).catch(() => {});
    }
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this._remoteSdp = desc.sdp;

    // Set ICE/DTLS role before creating the ICE agent
    if (desc.type === 'offer') {
      this._iceRole = 'controlled';
      // DTLS role will be determined by local SDP (a=setup:active/passive)
    } else if (desc.type === 'answer') {
      // Offerer path: determine DTLS role from the remote answer's a=setup attribute.
      // If remote answered 'active' they are DTLS client → we must be server.
      // If remote answered 'passive' they are DTLS server → we must be client.
      const remoteSetup = desc.sdp.match(/a=setup:(\w+)/)?.[1];
      if (remoteSetup === 'active') {
        this._dtlsRole = 'server';
      } else if (remoteSetup === 'passive') {
        this._dtlsRole = 'client';
      }
    }

    await this._ensureIceAgent();

    const { parseIceParameters, parseDtlsFingerprint, parseSctpPort, parseCandidatesFromSdp } =
      await import('./sdp-parser.js');

    const iceParams = parseIceParameters(desc.sdp);
    const fingerprint = parseDtlsFingerprint(desc.sdp);
    const sctpPort = parseSctpPort(desc.sdp);

    // Cache for use by setLocalDescription (answerer flow)
    this._remoteFingerprint = fingerprint;
    this._remoteSctpPort = sctpPort;

    if (iceParams) {
      this.iceAgent!.setRemoteParameters(iceParams);
    }

    const candidates = parseCandidatesFromSdp(desc.sdp);
    for (const candidate of candidates) {
      this.iceAgent!.addRemoteCandidate(candidate);
    }

    if (desc.sdp.includes('a=end-of-candidates')) {
      this.iceAgent!.remoteGatheringComplete();
    }

    if (this._localSdp) {
      this._startConnectivity(fingerprint, sctpPort).catch(() => {});
    }
  }

  async addIceCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.iceAgent) return;
    const { parseCandidatesFromSdp } = await import('./sdp-parser.js');
    // Wrap the candidate string in a minimal SDP-like format for the parser
    const candidateStr = init.candidate ?? '';
    if (!candidateStr) return;
    const fakeSdp = `a=candidate:${candidateStr.replace(/^candidate:/, '')}`;
    const [candidate] = parseCandidatesFromSdp(fakeSdp);
    if (candidate) {
      this.iceAgent.addRemoteCandidate(candidate);
    }
  }

  openDataChannel(channel: RTCDataChannel): void {
    if (this.sctpAssociation?.state === 'connected') {
      this._openDataChannelOnSctp(channel);
    } else {
      this._pendingDataChannels.push(channel);
    }
  }

  restartIce(): void {
    if (!this.iceAgent) return;
    // Reset ICE credentials and re-gather — forces re-negotiation
    this.iceAgent.restart().catch(() => {});
    this._pc._updateIceConnectionState('checking');
    // Signal that new local candidates will be available
    this._pc._updateIceGatheringState('gathering');
    // Trigger re-negotiation so the new ICE credentials are exchanged
    this._pc.emit('negotiationneeded');
  }

  close(): void {
    this.sctpAssociation?.close();
    this.dtlsTransport?.close();
    this.iceAgent?.close();
  }

  async getStats(): Promise<RTCStatsReportImpl> {
    const stats = new Map<string, RTCStats>();
    const now = Date.now();

    // Candidate pair stats
    const pair = this.iceAgent?.getSelectedPair();
    if (pair) {
      const localId = `local-candidate-${pair.local.foundation}`;
      const remoteId = `remote-candidate-${pair.remote.foundation}`;
      stats.set('candidate-pair-0', {
        id: 'candidate-pair-0',
        type: 'candidate-pair',
        timestamp: now,
        localCandidateId: localId,
        remoteCandidateId: remoteId,
        state: 'succeeded',
        nominated: true,
        bytesSent: 0,
        bytesReceived: 0,
        totalRoundTripTime: 0,
      } as import('../types.js').RTCIceCandidatePairStats);

      stats.set(localId, {
        id: localId,
        type: 'local-candidate',
        timestamp: now,
        candidateType: pair.local.type,
        ip: pair.local.address,
        port: pair.local.port,
        protocol: pair.local.transport,
        priority: pair.local.priority,
      } as RTCStats & Record<string, unknown>);

      stats.set(remoteId, {
        id: remoteId,
        type: 'remote-candidate',
        timestamp: now,
        candidateType: pair.remote.type,
        ip: pair.remote.address,
        port: pair.remote.port,
        protocol: pair.remote.transport,
        priority: pair.remote.priority,
      } as RTCStats & Record<string, unknown>);
    }

    // Transport stats
    if (this.dtlsTransport) {
      stats.set('transport-0', {
        id: 'transport-0',
        type: 'transport',
        timestamp: now,
        dtlsState: this.dtlsTransport.getState(),
        selectedCandidatePairId: pair ? 'candidate-pair-0' : undefined,
      } as RTCStats & Record<string, unknown>);
    }

    // Data channel stats (one per channel)
    if (this.sctpAssociation) {
      let dcIndex = 0;
      for (const [, sctpCh] of (this.sctpAssociation as unknown as { _channels: Map<number, import('@agentdance/node-webrtc-sctp').SctpDataChannel> })._channels) {
        const dcId = `data-channel-${dcIndex++}`;
        stats.set(dcId, {
          id: dcId,
          type: 'data-channel',
          timestamp: now,
          label: sctpCh.label,
          protocol: sctpCh.protocol,
          dataChannelIdentifier: sctpCh.id,
          state: sctpCh.state,
          messagesSent: 0,
          bytesSent: 0,
          messagesReceived: 0,
          bytesReceived: 0,
        } as RTCStats & Record<string, unknown>);
      }
    }

    // Peer connection stats
    stats.set('peer-connection', {
      id: 'peer-connection',
      type: 'peer-connection',
      timestamp: now,
      dataChannelsOpened: this.sctpAssociation
        ? (this.sctpAssociation as unknown as { _channels: Map<number, unknown> })._channels.size
        : 0,
      dataChannelsClosed: 0,
    } as RTCStats & Record<string, unknown>);

    return new RTCStatsReportImpl(stats);
  }

  private async _ensureCertificate(): Promise<void> {
    if (this.localCertificate) return;
    const { generateSelfSignedCertificate } = await import('@agentdance/node-webrtc-dtls');
    this.localCertificate = generateSelfSignedCertificate();
  }

  private async _ensureIceAgent(): Promise<void> {
    if (this.iceAgent) return;

    const { IceAgent, serializeCandidateAttribute } = await import('@agentdance/node-webrtc-ice');
    this.iceAgent = new IceAgent({
      stunServers: this._stunServers,
      role: this._iceRole,
    });

    this.iceAgent.on('local-candidate', (candidate: import('@agentdance/node-webrtc-ice').IceCandidate) => {
      this._pc.emit('icecandidate', {
        candidate: 'candidate:' + serializeCandidateAttribute(candidate),
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
    });

    this.iceAgent.on('gathering-complete', () => {
      this._pc._updateIceGatheringState('complete');
      this._pc.emit('icecandidate', null);
    });

    this.iceAgent.on('connection-state', (state: string) => {
      const stateMap: Record<string, import('../types.js').RTCIceConnectionState> = {
        new: 'new',
        checking: 'checking',
        connected: 'connected',
        completed: 'completed',
        failed: 'failed',
        disconnected: 'disconnected',
        closed: 'closed',
      };
      const mapped = stateMap[state] ?? 'new';
      this._pc._updateIceConnectionState(mapped);

      // Connection recovery: when ICE reconnects after a disconnect/failure,
      // restore peer connection state
      if (state === 'connected' || state === 'completed') {
        if (this._pc.connectionState === 'disconnected' || this._pc.connectionState === 'failed') {
          this._pc._updateConnectionState('connected');
        }
      } else if (state === 'disconnected') {
        if (this._pc.connectionState === 'connected') {
          this._pc._updateConnectionState('disconnected');
        }
      } else if (state === 'failed') {
        this._pc._updateConnectionState('failed');
      }
    });

    this.iceAgent.on('connected', async () => {
      this._pc._updateConnectionState('connecting');
    });
  }

  private async _startConnectivity(
    remoteFingerprint: { algorithm: string; value: string } | null,
    sctpPort: number | null,
  ): Promise<void> {
    if (!this.iceAgent) return;
    if (this.dtlsTransport) return; // Guard against double-start

    this._pc._updateIceConnectionState('checking');

    // Pre-create DTLS transport and wire ICE→DTLS BEFORE ICE connects,
    // so DTLS handshake packets are not lost when the remote sends first.
    const { DtlsTransport } = await import('@agentdance/node-webrtc-dtls');
    const dtlsOpts: import('@agentdance/node-webrtc-dtls').DtlsTransportOptions = {
      role: this._dtlsRole,
      ...(this.localCertificate ? { certificate: this.localCertificate } : {}),
    };
    if (remoteFingerprint !== null) {
      dtlsOpts.remoteFingerprint = remoteFingerprint;
    }
    this.dtlsTransport = new DtlsTransport(dtlsOpts);

    // Wire ICE → DTLS (packets received from remote)
    this.iceAgent.on('data', (data: Buffer) => {
      this.dtlsTransport!.handleIncoming(data);
    });

    // Wire DTLS → ICE (packets to send to remote)
    this.dtlsTransport.setSendCallback((data: Buffer) => {
      this.iceAgent!.send(data);
    });

    // Use event-driven approach: start DTLS when ICE nominates a pair.
    // This handles the race condition where connect() fails early in trickle ICE.
    const dtlsTransport = this.dtlsTransport;
    const startDtls = async () => {
      try {
        console.log('[PeerInternals] starting DTLS...');
        await dtlsTransport.start();
        console.log('[PeerInternals] DTLS connected, starting SCTP...');
        if (sctpPort !== null) {
          await this._startSctp(sctpPort);
          console.log('[PeerInternals] SCTP connected!');
        }
        this._pc._updateConnectionState('connected');
        console.log('[PeerInternals] connectionState=connected');
      } catch (e) {
        console.error('[PeerInternals] DTLS/SCTP failed:', e);
        this._pc._updateIceConnectionState('failed');
        this._pc._updateConnectionState('failed');
      }
    };

    // Start ICE connectivity checks
    try {
      await this.iceAgent.connect();
      // ICE is connected — start DTLS handshake
      await startDtls();
    } catch {
      // connect() may fail early due to trickle ICE timing.
      // The iceAgent 'connected' event will fire when ICE actually connects.
      // Register one-time handler.
      this.iceAgent.once('connected', () => {
        startDtls().catch(() => {});
      });
    }
  }

  private async _startSctp(remotePort: number): Promise<void> {
    const { SctpAssociation } = await import('@agentdance/node-webrtc-sctp');

    this.sctpAssociation = new SctpAssociation({
      localPort: 5000,
      remotePort,
      role: this._dtlsRole === 'client' ? 'client' : 'server',
    });

    // Wire DTLS ↔ SCTP
    this.dtlsTransport!.on('data', (data: Buffer) => {
      this.sctpAssociation!.handleIncoming(data);
    });

    this.sctpAssociation.setSendCallback((data: Buffer) => {
      this.dtlsTransport!.send(data);
    });

    // Handle incoming data channels
    this.sctpAssociation.on(
      'datachannel',
      (sctpChannel: import('@agentdance/node-webrtc-sctp').SctpDataChannel) => {
        const channel = new WebRTCDataChannel(
          sctpChannel.label,
          {
            ordered: sctpChannel.ordered,
            id: sctpChannel.id,
            protocol: sctpChannel.protocol,
          },
          sctpChannel,
        );
        this._pc.emit('datachannel', channel);
      },
    );

    await this.sctpAssociation.connect();

    // Open any pending data channels
    for (const dc of this._pendingDataChannels) {
      this._openDataChannelOnSctp(dc);
    }
    this._pendingDataChannels.length = 0;
  }

  private _openDataChannelOnSctp(channel: RTCDataChannel): void {
    if (!this.sctpAssociation) return;
    const opts: import('@agentdance/node-webrtc-sctp').DataChannelOptions = {
      label: channel.label,
      ordered: channel.ordered,
      protocol: channel.protocol,
      negotiated: channel.negotiated,
    };
    if (channel.maxRetransmits !== null) opts.maxRetransmits = channel.maxRetransmits;
    if (channel.maxPacketLifeTime !== null) opts.maxPacketLifeTime = channel.maxPacketLifeTime;
    // For negotiated channels, id must be provided; for auto channels, let SCTP assign
    if (channel.id !== null) opts.id = channel.id;

    const sctpChannel = this.sctpAssociation.createDataChannel(opts);
    channel._bindSctpChannel(sctpChannel);
  }
}
