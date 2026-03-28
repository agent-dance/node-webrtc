export type RTCSignalingState =
  | 'stable'
  | 'have-local-offer'
  | 'have-remote-offer'
  | 'have-local-pranswer'
  | 'have-remote-pranswer'
  | 'closed';

export type RTCPeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type RTCIceConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'closed';

export type RTCIceGatheringState = 'new' | 'gathering' | 'complete';

export type RTCSdpType = 'offer' | 'pranswer' | 'answer' | 'rollback';

export interface RTCSessionDescriptionInit {
  type: RTCSdpType;
  sdp: string;
}

export interface RTCSessionDescription {
  type: RTCSdpType;
  sdp: string;
}

export interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
  bundlePolicy?: 'balanced' | 'max-bundle' | 'max-compat';
  rtcpMuxPolicy?: 'require';
  iceCandidatePoolSize?: number;
  certificates?: RTCDtlsTransportCertificate[];
}

export interface RTCDtlsTransportCertificate {
  fingerprint: { algorithm: string; value: string };
}

export interface RTCOfferOptions {
  iceRestart?: boolean;
  offerToReceiveAudio?: boolean;
  offerToReceiveVideo?: boolean;
}

export interface RTCAnswerOptions {}

export type RTCRtpTransceiverDirection =
  | 'sendrecv'
  | 'sendonly'
  | 'recvonly'
  | 'inactive'
  | 'stopped';

export interface RTCRtpCodecParameters {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
  payloadType: number;
}

export interface RTCRtpHeaderExtensionParameters {
  uri: string;
  id: number;
  encrypted?: boolean;
}

export interface RTCRtpParameters {
  codecs: RTCRtpCodecParameters[];
  headerExtensions: RTCRtpHeaderExtensionParameters[];
}

export interface RTCRtpSendParameters extends RTCRtpParameters {
  encodings: RTCRtpEncodingParameters[];
  transactionId: string;
}

export interface RTCRtpReceiveParameters extends RTCRtpParameters {}

export interface RTCRtpEncodingParameters {
  rid?: string;
  active?: boolean;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
  ssrc?: number;
}

export interface RTCSctpTransportInit {
  maxMessageSize: number;
  maxChannels: number;
  state: 'new' | 'connecting' | 'connected' | 'closed';
}

export type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

export interface RTCDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
  priority?: 'very-low' | 'low' | 'medium' | 'high';
}

export interface RTCStats {
  id: string;
  type: string;
  timestamp: number;
}

export interface RTCIceCandidatePairStats extends RTCStats {
  type: 'candidate-pair';
  localCandidateId: string;
  remoteCandidateId: string;
  state: string;
  nominated: boolean;
  bytesSent: number;
  bytesReceived: number;
  totalRoundTripTime: number;
  currentRoundTripTime?: number;
}

export interface RTCStatsReport {
  readonly size: number;
  entries(): IterableIterator<[string, RTCStats]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<RTCStats>;
  get(id: string): RTCStats | undefined;
  has(id: string): boolean;
  forEach(callbackfn: (value: RTCStats, key: string) => void): void;
}
