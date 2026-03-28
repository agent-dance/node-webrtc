import { SrtpContext, SrtcpContext, ProtectionProfile } from './types.js';
import { aes128cmKeystream, computeSrtpIv, computeSrtcpIv } from './cipher.js';
import { computeSrtpAuthTag, computeSrtcpAuthTag } from './auth.js';
import { gcmSrtpProtect } from './gcm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Number of authentication-tag bytes for a given profile. */
function tagLength(profile: ProtectionProfile): 10 | 4 {
  return profile === ProtectionProfile.AES_128_CM_HMAC_SHA1_32 ? 4 : 10;
}

/** Parse the minimum fixed RTP header fields we need. */
function parseRtpHeader(pkt: Buffer): { seq: number; ssrc: number; headerLen: number } {
  if (pkt.length < 12) throw new RangeError('RTP packet too short (< 12 bytes)');
  const cc = pkt[0]! & 0x0f;
  const x = (pkt[0]! & 0x10) !== 0;
  let headerLen = 12 + cc * 4;
  if (x) {
    if (pkt.length < headerLen + 4) throw new RangeError('RTP extension header truncated');
    const extLen = pkt.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLen * 4;
  }
  return {
    seq: pkt.readUInt16BE(2),
    ssrc: pkt.readUInt32BE(8),
    headerLen,
  };
}

/** Parse the minimum fixed RTCP header fields. */
function parseRtcpHeader(pkt: Buffer): { ssrc: number } {
  if (pkt.length < 8) throw new RangeError('RTCP packet too short (< 8 bytes)');
  return { ssrc: pkt.readUInt32BE(4) };
}

/**
 * Advance the packet index (and ROC) for a sender-side protect call.
 * The index increments monotonically; ROC increments whenever the 16-bit
 * sequence counter wraps.
 */
function nextSrtpIndex(ctx: SrtpContext, seq: number): bigint {
  if (ctx.lastSeq === -1) {
    // First packet
    return BigInt(ctx.rolloverCounter) << 16n | BigInt(seq);
  }
  const roc = BigInt(ctx.rolloverCounter);
  const lastSeq = ctx.lastSeq;

  // Detect forward wrap-around (65535 → 0)
  if (seq < lastSeq && lastSeq - seq > 0x8000) {
    return (roc + 1n) << 16n | BigInt(seq);
  }
  return roc << 16n | BigInt(seq);
}

// ---------------------------------------------------------------------------
// SRTP protect (RFC 3711 §3.1)
// ---------------------------------------------------------------------------

/**
 * Protect (encrypt + authenticate) an RTP packet.
 *
 * Output layout:
 *   RTP Header (unchanged) | Encrypted Payload | Auth Tag (10 or 4 bytes)
 *
 * GCM profiles are handled by delegating to `gcmSrtpProtect`.
 */
export function srtpProtect(ctx: SrtpContext, rtpPacket: Buffer): Buffer {
  if (
    ctx.profile === ProtectionProfile.AES_128_GCM ||
    ctx.profile === ProtectionProfile.AES_256_GCM
  ) {
    return gcmSrtpProtect(ctx, rtpPacket);
  }

  const { seq, ssrc, headerLen } = parseRtpHeader(rtpPacket);
  const index = nextSrtpIndex(ctx, seq);

  const header = rtpPacket.subarray(0, headerLen);
  const payload = rtpPacket.subarray(headerLen);

  // 1. Encrypt the payload with AES-128-CM
  const iv = computeSrtpIv(ctx.sessionSaltKey, ssrc, index);
  const keystream = aes128cmKeystream(ctx.sessionEncKey, iv, payload.length);
  const encryptedPayload = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    encryptedPayload[i] = payload[i]! ^ keystream[i]!;
  }

  // 2. Compute HMAC-SHA1 auth tag over header || encrypted_payload || ROC
  const roc = Number(index >> 16n) >>> 0;
  const tag = computeSrtpAuthTag(
    ctx.sessionAuthKey,
    header,
    encryptedPayload,
    roc,
    tagLength(ctx.profile),
  );

  // 3. Update context state
  ctx.index = index;
  ctx.rolloverCounter = roc;
  ctx.lastSeq = seq;

  return Buffer.concat([header, encryptedPayload, tag]);
}

// ---------------------------------------------------------------------------
// SRTCP protect (RFC 3711 §3.4)
// ---------------------------------------------------------------------------

/**
 * Protect (encrypt + authenticate) an RTCP packet.
 *
 * Output layout:
 *   RTCP Header (8 bytes, unencrypted) |
 *   Encrypted Remainder |
 *   E (1 bit, always 1) | SRTCP Index (31 bits) |
 *   Auth Tag (10 bytes)
 */
export function srtcpProtect(ctx: SrtcpContext, rtcpPacket: Buffer): Buffer {
  if (rtcpPacket.length < 8) throw new RangeError('RTCP packet too short');

  const { ssrc } = parseRtcpHeader(rtcpPacket);

  // Increment and clamp to 31 bits
  const index = (ctx.index + 1) & 0x7fffffff;
  ctx.index = index;

  // First 8 bytes of RTCP are left unencrypted (fixed header).
  const header = rtcpPacket.subarray(0, 8);
  const rest = rtcpPacket.subarray(8);

  // Encrypt the rest with AES-128-CM
  const iv = computeSrtcpIv(ctx.sessionSaltKey, ssrc, index);
  const keystream = aes128cmKeystream(ctx.sessionEncKey, iv, rest.length);
  const encrypted = Buffer.allocUnsafe(rest.length);
  for (let i = 0; i < rest.length; i++) {
    encrypted[i] = rest[i]! ^ keystream[i]!;
  }

  // Build E || SRTCP_index word (E=1 means packet is encrypted)
  const eSrtcpIndex = 0x80000000 | (index & 0x7fffffff);
  const indexBuf = Buffer.allocUnsafe(4);
  indexBuf.writeUInt32BE(eSrtcpIndex >>> 0, 0);

  // Auth tag covers: header || encrypted_rest || E_SRTCP_index
  const packetForAuth = Buffer.concat([header, encrypted]);
  const tag = computeSrtcpAuthTag(
    ctx.sessionAuthKey,
    packetForAuth,
    eSrtcpIndex,
    tagLength(ctx.profile),
  );

  return Buffer.concat([header, encrypted, indexBuf, tag]);
}
