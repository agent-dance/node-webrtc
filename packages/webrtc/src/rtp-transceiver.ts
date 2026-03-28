import { EventEmitter } from 'events';
import type { RTCRtpTransceiverDirection } from './types.js';
import { RTCRtpSender } from './rtp-sender.js';
import { RTCRtpReceiver } from './rtp-receiver.js';

export class RTCRtpTransceiver extends EventEmitter {
  readonly kind: 'audio' | 'video';
  readonly sender: RTCRtpSender;
  readonly receiver: RTCRtpReceiver;
  readonly mid: string | null = null;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null = null;
  stopped = false;

  constructor(kind: 'audio' | 'video', direction: RTCRtpTransceiverDirection) {
    super();
    this.kind = kind;
    this.sender = new RTCRtpSender(null);
    this.receiver = new RTCRtpReceiver();
    this.direction = direction;
  }

  stop(): void {
    this.stopped = true;
    this.direction = 'stopped';
    this.currentDirection = 'stopped';
  }

  setCodecPreferences(codecs: RTCRtpCodecParameters[]): void {
    // Store codec preferences for SDP generation
  }
}

interface RTCRtpCodecParameters {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
  payloadType: number;
}
