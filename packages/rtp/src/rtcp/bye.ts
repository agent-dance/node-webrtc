/**
 * RTCP BYE — RFC 3550 Section 6.6
 */

import type { RtcpBye } from '../types.js';

const BYE_HEADER_SIZE = 4;

export function encodeBye(bye: RtcpBye): Buffer {
  const sc = bye.ssrcs.length;

  // Reason string (optional)
  let reasonBuf: Buffer = Buffer.alloc(0);
  if (bye.reason !== undefined) {
    const text = Buffer.from(bye.reason, 'utf8');
    const reasonLen = Math.min(text.length, 255);
    // 1 byte length prefix + text + padding to 4-byte boundary
    const raw = Buffer.allocUnsafe(1 + reasonLen);
    raw[0] = reasonLen;
    text.copy(raw, 1, 0, reasonLen);
    const padded = reasonLen + 1;
    const padLen = (4 - (padded % 4)) % 4;
    reasonBuf = Buffer.concat([raw, Buffer.alloc(padLen, 0x00)]);
  }

  const totalBytes = BYE_HEADER_SIZE + sc * 4 + reasonBuf.length;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | (sc & 0x1f);
  buf[1] = 203;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);

  let offset = BYE_HEADER_SIZE;
  for (const ssrc of bye.ssrcs) {
    buf.writeUInt32BE(ssrc >>> 0, offset);
    offset += 4;
  }

  if (reasonBuf.length > 0) {
    reasonBuf.copy(buf, offset);
  }

  return buf;
}

export function decodeBye(buf: Buffer): RtcpBye {
  if (buf.length < BYE_HEADER_SIZE) {
    throw new RangeError(`BYE packet too short: ${buf.length}`);
  }

  const sc = buf[0]! & 0x1f;
  const totalBytes = (buf.readUInt16BE(2) + 1) * 4;

  const ssrcs: number[] = [];
  let offset = BYE_HEADER_SIZE;

  for (let i = 0; i < sc; i++) {
    if (offset + 4 > buf.length) break;
    ssrcs.push(buf.readUInt32BE(offset));
    offset += 4;
  }

  let reason: string | undefined;
  if (offset < totalBytes && offset < buf.length) {
    const reasonLen = buf[offset];
    if (reasonLen !== undefined && reasonLen > 0) {
      offset++;
      reason = buf.subarray(offset, offset + reasonLen).toString('utf8');
    }
  }

  return { ssrcs, ...(reason !== undefined ? { reason } : {}) };
}
