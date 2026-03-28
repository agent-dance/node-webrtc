import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// HMAC-SHA1 authentication tags  (RFC 3711 §4.2)
// ---------------------------------------------------------------------------

/**
 * Compute the SRTP authentication tag.
 *
 * auth_tag = first `tagLength` bytes of
 *            HMAC-SHA1(k_a, RTP_header || RTP_payload || ROC_be32)
 *
 * @param authKey    20-byte HMAC-SHA1 session authentication key
 * @param rtpHeader  The full RTP header (variable length)
 * @param rtpPayload The plain RTP payload (pre-encryption for sender,
 *                   already encrypted on sender side per RFC 3711 §3.1)
 * @param roc        Roll-Over Counter (big-endian 32-bit appended)
 * @param tagLength  10 for 80-bit profile, 4 for 32-bit profile
 */
export function computeSrtpAuthTag(
  authKey: Buffer,
  rtpHeader: Buffer,
  rtpPayload: Buffer,
  roc: number,
  tagLength: 10 | 4,
): Buffer {
  const rocBuf = Buffer.allocUnsafe(4);
  rocBuf.writeUInt32BE(roc >>> 0, 0);

  const hmac = createHmac('sha1', authKey);
  hmac.update(rtpHeader);
  hmac.update(rtpPayload);
  hmac.update(rocBuf);
  return hmac.digest().subarray(0, tagLength);
}

/**
 * Compute the SRTCP authentication tag.
 *
 * auth_tag = first `tagLength` bytes of
 *            HMAC-SHA1(k_a, RTCP_packet || E_SRTCP_index_be32)
 *
 * @param authKey       20-byte HMAC-SHA1 session authentication key
 * @param rtcpPacket    The full (partially encrypted) RTCP packet bytes
 * @param eSrtcpIndex   The 32-bit word: E(1) || SRTCP_index(31)
 * @param tagLength     10 for 80-bit profile, 4 for 32-bit profile
 */
export function computeSrtcpAuthTag(
  authKey: Buffer,
  rtcpPacket: Buffer,
  eSrtcpIndex: number,
  tagLength: 10 | 4,
): Buffer {
  const indexBuf = Buffer.allocUnsafe(4);
  indexBuf.writeUInt32BE(eSrtcpIndex >>> 0, 0);

  const hmac = createHmac('sha1', authKey);
  hmac.update(rtcpPacket);
  hmac.update(indexBuf);
  return hmac.digest().subarray(0, tagLength);
}
