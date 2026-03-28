import { EventEmitter } from 'events';
import type { RTCRtpSendParameters, RTCRtpEncodingParameters } from './types.js';

// Minimal track interface for Node.js (browser MediaStreamTrack not available)
export interface MediaStreamTrack {
  kind: string;
  id: string;
  enabled: boolean;
  muted: boolean;
  readyState: 'live' | 'ended';
}

export class RTCRtpSender extends EventEmitter {
  readonly track: MediaStreamTrack | null;
  readonly transport: RTCDtlsTransport | null = null;
  private _parameters: RTCRtpSendParameters;

  constructor(track: MediaStreamTrack | null) {
    super();
    this.track = track;
    this._parameters = {
      codecs: [],
      headerExtensions: [],
      encodings: [],
      transactionId: '',
    };
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  getParameters(): RTCRtpSendParameters {
    return { ...this._parameters };
  }

  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    this._parameters = params;
  }

  replaceTrack(withTrack: MediaStreamTrack | null): Promise<void> {
    (this as unknown as { track: MediaStreamTrack | null }).track = withTrack;
    return Promise.resolve();
  }

  static getCapabilities(kind: string): { codecs: unknown[]; headerExtensions: unknown[] } | null {
    // Return default codec capabilities
    if (kind === 'audio') {
      return {
        codecs: [
          { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
          { mimeType: 'audio/PCMU', clockRate: 8000 },
          { mimeType: 'audio/PCMA', clockRate: 8000 },
        ],
        headerExtensions: [
          { uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', id: 1 },
        ],
      };
    } else if (kind === 'video') {
      return {
        codecs: [
          { mimeType: 'video/VP8', clockRate: 90000 },
          { mimeType: 'video/VP9', clockRate: 90000 },
          { mimeType: 'video/H264', clockRate: 90000 },
        ],
        headerExtensions: [
          { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 2 },
        ],
      };
    }
    return null;
  }
}

// Stub types for compatibility
interface RTCDtlsTransport {}
interface RTCStatsReport {}
