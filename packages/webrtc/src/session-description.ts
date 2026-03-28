import type { RTCSessionDescriptionInit, RTCSdpType } from './types.js';

export class RTCSessionDescription implements RTCSessionDescriptionInit {
  readonly type: RTCSdpType;
  readonly sdp: string;

  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type;
    this.sdp = init.sdp;
  }

  toJSON(): RTCSessionDescriptionInit {
    return { type: this.type, sdp: this.sdp };
  }
}
