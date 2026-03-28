/**
 * RTCP Sender Report (SR) — RFC 3550 Section 6.4.1
 */

import type { RtcpSenderReport, ReportBlock } from '../types.js';
import { encodeReportBlock, decodeReportBlock, REPORT_BLOCK_SIZE } from './rr.js';

/** Fixed size of SR sender info block (without report blocks) */
const SR_SENDER_INFO_SIZE = 20; // 5 x 32-bit words

/** Full SR packet size without report blocks: 4 (common hdr) + 4 (SSRC) + 20 (sender info) */
export const SR_BASE_SIZE = 28;

export function encodeSr(sr: RtcpSenderReport): Buffer {
  const blockCount = sr.reportBlocks.length;
  const totalBytes = SR_BASE_SIZE + blockCount * REPORT_BLOCK_SIZE;
  const buf = Buffer.allocUnsafe(totalBytes);

  // Common RTCP header
  // V=2, P=0, RC=blockCount, PT=200
  buf[0] = (2 << 6) | (blockCount & 0x1f);
  buf[1] = 200;
  // Length in 32-bit words minus 1
  const lengthWords = totalBytes / 4 - 1;
  buf.writeUInt16BE(lengthWords, 2);

  // SSRC
  buf.writeUInt32BE(sr.ssrc >>> 0, 4);

  // NTP timestamp (64-bit)
  buf.writeBigUInt64BE(sr.ntpTimestamp, 8);

  // RTP timestamp
  buf.writeUInt32BE(sr.rtpTimestamp >>> 0, 16);

  // Packet count
  buf.writeUInt32BE(sr.packetCount >>> 0, 20);

  // Octet count
  buf.writeUInt32BE(sr.octetCount >>> 0, 24);

  // Report blocks
  let offset = SR_BASE_SIZE;
  for (const rb of sr.reportBlocks) {
    encodeReportBlock(rb, buf, offset);
    offset += REPORT_BLOCK_SIZE;
  }

  return buf;
}

export function decodeSr(buf: Buffer): RtcpSenderReport {
  if (buf.length < SR_BASE_SIZE) {
    throw new RangeError(`SR packet too short: ${buf.length}`);
  }

  // byte[0]: V(2)|P(1)|RC(5)  — RC = report count
  const rc = (buf[0]! & 0x1f);

  const ssrc = buf.readUInt32BE(4);
  const ntpTimestamp = buf.readBigUInt64BE(8);
  const rtpTimestamp = buf.readUInt32BE(16);
  const packetCount = buf.readUInt32BE(20);
  const octetCount = buf.readUInt32BE(24);

  const reportBlocks: ReportBlock[] = [];
  let offset = SR_BASE_SIZE;
  for (let i = 0; i < rc; i++) {
    if (offset + REPORT_BLOCK_SIZE > buf.length) break;
    reportBlocks.push(decodeReportBlock(buf, offset));
    offset += REPORT_BLOCK_SIZE;
  }

  return { ssrc, ntpTimestamp, rtpTimestamp, packetCount, octetCount, reportBlocks };
}
