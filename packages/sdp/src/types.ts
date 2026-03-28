export interface SessionDescription {
  version: number;
  origin: Origin;
  sessionName: string;
  timing: Timing;
  groups: Group[];
  msidSemantic?: string;
  mediaDescriptions: MediaDescription[];
}

export interface Origin {
  username: string;
  sessionId: string;
  sessionVersion: number;
  networkType: string;
  addressType: string;
  unicastAddress: string;
}

export interface Timing {
  startTime: number;
  stopTime: number;
}

export interface Group {
  semantic: string;
  mids: string[];
}

export interface MediaDescription {
  type: string;
  port: number;
  protocol: string;
  payloadTypes: number[];
  connection?: Connection;
  bandwidth?: Bandwidth;
  rtpMaps: RtpMap[];
  fmtps: Fmtp[];
  rtcpFbs: RtcpFb[];
  candidates: IceCandidate[];
  iceUfrag?: string;
  icePwd?: string;
  iceOptions?: string;
  iceGatheringState?: string;
  fingerprint?: Fingerprint;
  setup?: string;
  mid?: string;
  direction?: Direction;
  rtcp?: RtcpAttr;
  rtcpMux?: boolean;
  rtcpRsize?: boolean;
  ssrcs: Ssrc[];
  ssrcGroups: SsrcGroup[];
  msid?: string;
  extmaps: Extmap[];
  sctpPort?: number;
  maxMessageSize?: number;
  endOfCandidates?: boolean;
}

export type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

export interface RtpMap {
  payloadType: number;
  encoding: string;
  clockRate: number;
  encodingParams?: string;
}

export interface Fmtp {
  payloadType: number;
  parameters: string;
}

export interface RtcpFb {
  payloadType: number;
  type: string;
  parameter?: string;
}

export interface IceCandidate {
  foundation: string;
  component: number;
  transport: string;
  priority: number;
  address: string;
  port: number;
  type: string;
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: string;
  generation?: number;
  ufrag?: string;
  networkId?: number;
  networkCost?: number;
  extensions?: Record<string, string>;
}

export interface Fingerprint {
  algorithm: string;
  value: string;
}

export interface Connection {
  networkType: string;
  addressType: string;
  address: string;
}

export interface Bandwidth {
  type: string;
  bandwidth: number;
}

export interface Ssrc {
  id: number;
  attribute: string;
  value?: string;
}

export interface SsrcGroup {
  semantic: string;
  ssrcIds: number[];
}

export interface Extmap {
  id: number;
  direction?: string;
  uri: string;
  attributes?: string;
}

export interface RtcpAttr {
  port: number;
  networkType?: string;
  addressType?: string;
  address?: string;
}
