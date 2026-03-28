/**
 * @agentdance/node-webrtc-rtp — RFC 3550 RTP/RTCP implementation
 */

export type {
  RtpPacket,
  RtpHeaderExtension,
  RtpExtensionValue,
  RtcpHeader,
  RtcpSenderReport,
  RtcpReceiverReport,
  ReportBlock,
  RtcpSdes,
  SdesChunk,
  SdesItem,
  RtcpBye,
  RtcpNack,
  RtcpPli,
  RtcpFir,
  FirEntry,
  RtcpRemb,
  RtcpPacket,
} from './types.js';

export { RtcpPacketType } from './types.js';

// RTP
export { encodeRtp, decodeRtp, isRtpPacket } from './rtp.js';

// RTCP compound
export { encodeRtcp, decodeRtcp, isRtcpPacket } from './rtcp/index.js';

// RTCP individual encoders/decoders
export { encodeSr, decodeSr } from './rtcp/sr.js';
export { encodeRr, decodeRr, encodeReportBlock, decodeReportBlock } from './rtcp/rr.js';
export { encodeSdes, decodeSdes } from './rtcp/sdes.js';
export { encodeBye, decodeBye } from './rtcp/bye.js';
export {
  encodeNack,
  decodeNack,
  encodePli,
  decodePli,
  encodeFir,
  decodeFir,
  encodeRemb,
  decodeRemb,
} from './rtcp/fb.js';

// Header extensions
export {
  ONE_BYTE_PROFILE,
  TWO_BYTE_PROFILE,
  parseExtensionValues,
  serializeExtensionValues,
  serializeExtension,
  getExtensionValue,
  setExtensionValue,
} from './extension.js';

// Sequence utilities
export {
  seqDiff,
  seqLt,
  seqLte,
  seqGt,
  ntpToUnix,
  unixToNtp,
} from './sequence.js';
