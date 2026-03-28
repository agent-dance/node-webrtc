/**
 * RTCP Receiver Report (RR) — RFC 3550 Section 6.4.2
 * Also provides shared ReportBlock encode/decode helpers.
 */

import type { RtcpReceiverReport, ReportBlock } from '../types.js';

/** Each report block is exactly 24 bytes (6 x 32-bit words) */
export const REPORT_BLOCK_SIZE = 24;

/** RR base size: 4 (common hdr) + 4 (SSRC) */
const RR_BASE_SIZE = 8;

export function encodeReportBlock(rb: ReportBlock, buf: Buffer, offset: number): void {
  buf.writeUInt32BE(rb.ssrc >>> 0, offset);

  // fractionLost (8 bits) | cumulativeLost (24 bits, two's complement)
  const cumLost = rb.cumulativeLost & 0xffffff;
  buf.writeUInt32BE(((rb.fractionLost & 0xff) << 24) | cumLost, offset + 4);

  buf.writeUInt32BE(rb.extendedHighestSeq >>> 0, offset + 8);
  buf.writeUInt32BE(rb.jitter >>> 0, offset + 12);
  buf.writeUInt32BE(rb.lastSR >>> 0, offset + 16);
  buf.writeUInt32BE(rb.delaySinceLastSR >>> 0, offset + 20);
}

export function decodeReportBlock(buf: Buffer, offset: number): ReportBlock {
  const ssrc = buf.readUInt32BE(offset);
  const word2 = buf.readUInt32BE(offset + 4);

  const fractionLost = (word2 >>> 24) & 0xff;
  // cumulativeLost is 24-bit signed
  let cumulativeLost = word2 & 0xffffff;
  if (cumulativeLost & 0x800000) {
    cumulativeLost = cumulativeLost - 0x1000000; // sign extend
  }

  const extendedHighestSeq = buf.readUInt32BE(offset + 8);
  const jitter = buf.readUInt32BE(offset + 12);
  const lastSR = buf.readUInt32BE(offset + 16);
  const delaySinceLastSR = buf.readUInt32BE(offset + 20);

  return { ssrc, fractionLost, cumulativeLost, extendedHighestSeq, jitter, lastSR, delaySinceLastSR };
}

export function encodeRr(rr: RtcpReceiverReport): Buffer {
  const blockCount = rr.reportBlocks.length;
  const totalBytes = RR_BASE_SIZE + blockCount * REPORT_BLOCK_SIZE;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | (blockCount & 0x1f);
  buf[1] = 201;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);
  buf.writeUInt32BE(rr.ssrc >>> 0, 4);

  let offset = RR_BASE_SIZE;
  for (const rb of rr.reportBlocks) {
    encodeReportBlock(rb, buf, offset);
    offset += REPORT_BLOCK_SIZE;
  }

  return buf;
}

export function decodeRr(buf: Buffer): RtcpReceiverReport {
  if (buf.length < RR_BASE_SIZE) {
    throw new RangeError(`RR packet too short: ${buf.length}`);
  }

  const rc = (buf[0]! & 0x1f);
  const ssrc = buf.readUInt32BE(4);

  const reportBlocks: ReportBlock[] = [];
  let offset = RR_BASE_SIZE;
  for (let i = 0; i < rc; i++) {
    if (offset + REPORT_BLOCK_SIZE > buf.length) break;
    reportBlocks.push(decodeReportBlock(buf, offset));
    offset += REPORT_BLOCK_SIZE;
  }

  return { ssrc, reportBlocks };
}
