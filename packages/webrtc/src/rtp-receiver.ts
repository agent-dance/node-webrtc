import { EventEmitter } from 'events';
import type { RTCRtpReceiveParameters } from './types.js';
import type { MediaStreamTrack } from './rtp-sender.js';

export class RTCRtpReceiver extends EventEmitter {
  readonly track: MediaStreamTrack | null = null;
  readonly transport: RTCDtlsTransport | null = null;

  getParameters(): RTCRtpReceiveParameters {
    return { codecs: [], headerExtensions: [] };
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  getContributingSources(): RTCRtpContributingSource[] {
    return [];
  }

  getSynchronizationSources(): RTCRtpSynchronizationSource[] {
    return [];
  }

  static getCapabilities(kind: string): { codecs: unknown[]; headerExtensions: unknown[] } | null {
    if (kind === 'audio') {
      return {
        codecs: [
          { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
          { mimeType: 'audio/PCMU', clockRate: 8000 },
        ],
        headerExtensions: [],
      };
    } else if (kind === 'video') {
      return {
        codecs: [
          { mimeType: 'video/VP8', clockRate: 90000 },
          { mimeType: 'video/VP9', clockRate: 90000 },
        ],
        headerExtensions: [],
      };
    }
    return null;
  }
}

// Stub types
interface RTCDtlsTransport {}
interface RTCStatsReport {}
interface RTCRtpContributingSource { source: number; timestamp: number; audioLevel?: number; }
interface RTCRtpSynchronizationSource extends RTCRtpContributingSource {}
