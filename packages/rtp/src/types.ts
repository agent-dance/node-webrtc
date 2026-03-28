// RFC 3550 RTP/RTCP types

export interface RtpPacket {
  version: 2;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  csrcs: number[];
  headerExtension?: RtpHeaderExtension;
  payload: Buffer;
}

export interface RtpHeaderExtension {
  id: number; // profile: 0xBEDE = one-byte, 0x1000 = two-byte
  values: RtpExtensionValue[];
}

export interface RtpExtensionValue {
  id: number;
  data: Buffer;
}

export enum RtcpPacketType {
  SR = 200,
  RR = 201,
  SDES = 202,
  BYE = 203,
  APP = 204,
  TransportFeedback = 205,
  PayloadFeedback = 206,
}

export interface RtcpHeader {
  version: 2;
  padding: boolean;
  count: number; // also FMT for feedback packets
  packetType: RtcpPacketType;
  length: number; // in 32-bit words minus 1
}

export interface RtcpSenderReport {
  ssrc: number;
  ntpTimestamp: bigint; // 64-bit NTP timestamp
  rtpTimestamp: number;
  packetCount: number;
  octetCount: number;
  reportBlocks: ReportBlock[];
}

export interface RtcpReceiverReport {
  ssrc: number;
  reportBlocks: ReportBlock[];
}

export interface ReportBlock {
  ssrc: number;
  fractionLost: number; // 8-bit fraction
  cumulativeLost: number; // 24-bit signed
  extendedHighestSeq: number;
  jitter: number;
  lastSR: number;
  delaySinceLastSR: number;
}

export interface RtcpSdes {
  chunks: SdesChunk[];
}

export interface SdesChunk {
  ssrc: number;
  items: SdesItem[];
}

export interface SdesItem {
  type: number; // 1=CNAME, 2=NAME, 3=EMAIL, 4=PHONE, 5=LOC, 6=TOOL, 7=NOTE, 8=PRIV
  text: string;
}

export interface RtcpBye {
  ssrcs: number[];
  reason?: string;
}

// Feedback messages (RFC 4585)
export interface RtcpNack {
  senderSsrc: number;
  mediaSsrc: number;
  pid: number;
  blp: number; // bitmask of following lost packets
}

export interface RtcpPli {
  senderSsrc: number;
  mediaSsrc: number;
}

export interface RtcpFir {
  senderSsrc: number;
  entries: FirEntry[];
}

export interface FirEntry {
  ssrc: number;
  seqNumber: number;
}

// REMB (draft-alvestrand-rmcat-remb)
export interface RtcpRemb {
  senderSsrc: number;
  mediaSsrc: number;
  bitrate: number; // bits per second
  ssrcs: number[];
}

export type RtcpPacket =
  | { type: 'sr'; packet: RtcpSenderReport }
  | { type: 'rr'; packet: RtcpReceiverReport }
  | { type: 'sdes'; packet: RtcpSdes }
  | { type: 'bye'; packet: RtcpBye }
  | { type: 'nack'; packet: RtcpNack }
  | { type: 'pli'; packet: RtcpPli }
  | { type: 'fir'; packet: RtcpFir }
  | { type: 'remb'; packet: RtcpRemb }
  | { type: 'unknown'; raw: Buffer };
