export class RTCIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;

  // Parsed fields
  readonly foundation: string | null = null;
  readonly component: 'rtp' | 'rtcp' | null = null;
  readonly protocol: 'udp' | 'tcp' | null = null;
  readonly priority: number | null = null;
  readonly address: string | null = null;
  readonly port: number | null = null;
  readonly type: 'host' | 'srflx' | 'relay' | 'prflx' | null = null;
  relatedAddress: string | null = null;
  relatedPort: number | null = null;
  tcpType: string | null = null;

  constructor(init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number; usernameFragment?: string }) {
    this.candidate = init.candidate ?? '';
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
    this.usernameFragment = init.usernameFragment ?? null;

    // Parse candidate string
    const parsed = this._parse(this.candidate);
    if (parsed) {
      (this as { foundation: string | null }).foundation = parsed.foundation;
      (this as { component: 'rtp' | 'rtcp' | null }).component = parsed.component;
      (this as { protocol: 'udp' | 'tcp' | null }).protocol = parsed.protocol;
      (this as { priority: number | null }).priority = parsed.priority;
      (this as { address: string | null }).address = parsed.address;
      (this as { port: number | null }).port = parsed.port;
      (this as { type: 'host' | 'srflx' | 'relay' | 'prflx' | null }).type = parsed.type;
      this.relatedAddress = parsed.relatedAddress;
      this.relatedPort = parsed.relatedPort;
      this.tcpType = parsed.tcpType;
    }
  }

  private _parse(candidateStr: string): {
    foundation: string | null;
    component: 'rtp' | 'rtcp' | null;
    protocol: 'udp' | 'tcp' | null;
    priority: number | null;
    address: string | null;
    port: number | null;
    type: 'host' | 'srflx' | 'relay' | 'prflx' | null;
    relatedAddress: string | null;
    relatedPort: number | null;
    tcpType: string | null;
  } | null {
    // "candidate:foundation component protocol priority address port typ type ..."
    const str = candidateStr.replace(/^candidate:/, '');
    const parts = str.split(' ');
    if (parts.length < 8) return null;
    const [foundation, componentStr, protocol, priorityStr, address, portStr, , type, ...rest] = parts;

    const result = {
      foundation: foundation ?? null,
      component: (componentStr === '1' ? 'rtp' : 'rtcp') as 'rtp' | 'rtcp' | null,
      protocol: (protocol?.toLowerCase() as 'udp' | 'tcp') ?? null,
      priority: priorityStr ? parseInt(priorityStr, 10) : null,
      address: address ?? null,
      port: portStr ? parseInt(portStr, 10) : null,
      type: (type as 'host' | 'srflx' | 'relay' | 'prflx') ?? null,
      relatedAddress: null as string | null,
      relatedPort: null as number | null,
      tcpType: null as string | null,
    };

    // Parse extensions
    for (let i = 0; i < rest.length - 1; i += 2) {
      const key = rest[i];
      const val = rest[i + 1];
      if (key === 'raddr') result.relatedAddress = val ?? null;
      else if (key === 'rport') result.relatedPort = val ? parseInt(val, 10) : null;
      else if (key === 'tcptype') result.tcpType = val ?? null;
    }
    return result;
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}
