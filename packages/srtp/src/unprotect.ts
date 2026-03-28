import { SrtpContext, SrtcpContext, ProtectionProfile } from './types.js';
import { aes128cmKeystream, computeSrtpIv, computeSrtcpIv } from './cipher.js';
import { computeSrtpAuthTag, computeSrtcpAuthTag } from './auth.js';
import { gcmSrtpUnprotect } from './gcm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tagLength(profile: ProtectionProfile): 10 | 4 {
  return profile === ProtectionProfile.AES_128_CM_HMAC_SHA1_32 ? 4 : 10;
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
}

/** Parse the minimum fixed RTP header fields. */
function parseRtpHeader(pkt: Buffer): { seq: number; ssrc: number; headerLen: number } {
  if (pkt.length < 12) return { seq: 0, ssrc: 0, headerLen: 0 };
  const cc = pkt[0]! & 0x0f;
  const x = (pkt[0]! & 0x10) !== 0;
  let headerLen = 12 + cc * 4;
  if (x && pkt.length >= headerLen + 4) {
    const extLen = pkt.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLen * 4;
  }
  return {
    seq: pkt.readUInt16BE(2),
    ssrc: pkt.readUInt32BE(8),
    headerLen,
  };
}

/**
 * RFC 3711 §3.3.1 – estimate the full 48-bit packet index from a received
 * 16-bit sequence number and the current context state.
 */
function estimateSrtpIndex(ctx: SrtpContext, seq: number): bigint {
  if (ctx.lastSeq === -1) {
    // No previous packet; accept as-is with the current ROC.
    return BigInt(ctx.rolloverCounter) << 16n | BigInt(seq);
  }

  const v = BigInt(ctx.rolloverCounter);
  const diff = seq - ctx.lastSeq;

  if (diff > 0x8000) {
    // seq is much higher than lastSeq → previous ROC (seq wrapped backwards)
    return (v === 0n ? 0n : v - 1n) << 16n | BigInt(seq);
  } else if (diff < -0x8000) {
    // seq is much lower than lastSeq → ROC has incremented (forward wrap)
    return (v + 1n) << 16n | BigInt(seq);
  }
  return v << 16n | BigInt(seq);
}

// ---------------------------------------------------------------------------
// SRTP unprotect (RFC 3711 §3.1)
// ---------------------------------------------------------------------------

/**
 * Authenticate and decrypt an SRTP packet.
 *
 * @returns Plaintext RTP packet, or `null` if auth fails / replay detected.
 */
export function srtpUnprotect(ctx: SrtpContext, srtpPacket: Buffer): Buffer | null {
  if (
    ctx.profile === ProtectionProfile.AES_128_GCM ||
    ctx.profile === ProtectionProfile.AES_256_GCM
  ) {
    return gcmSrtpUnprotect(ctx, srtpPacket);
  }

  const tl = tagLength(ctx.profile);

  if (srtpPacket.length < 12 + tl) return null;

  const { seq, ssrc, headerLen } = parseRtpHeader(srtpPacket);
  if (headerLen === 0) return null;
  if (srtpPacket.length < headerLen + tl) return null;

  // 1. Estimate packet index (handles ROC)
  const index = estimateSrtpIndex(ctx, seq);

  // 2. Replay check (before expensive crypto)
  if (!ctx.replayWindow.check(index)) return null;

  // 3. Split the packet
  const header = srtpPacket.subarray(0, headerLen);
  const encryptedPayload = srtpPacket.subarray(headerLen, srtpPacket.length - tl);
  const receivedTag = srtpPacket.subarray(srtpPacket.length - tl);

  // 4. Verify auth tag
  const roc = Number(index >> 16n) >>> 0;
  const expectedTag = computeSrtpAuthTag(ctx.sessionAuthKey, header, encryptedPayload, roc, tl);
  if (!timingSafeEqual(expectedTag, receivedTag)) return null;

  // 5. Decrypt payload (AES-128-CM is symmetric: XOR with keystream)
  const iv = computeSrtpIv(ctx.sessionSaltKey, ssrc, index);
  const keystream = aes128cmKeystream(ctx.sessionEncKey, iv, encryptedPayload.length);
  const payload = Buffer.allocUnsafe(encryptedPayload.length);
  for (let i = 0; i < encryptedPayload.length; i++) {
    payload[i] = encryptedPayload[i]! ^ keystream[i]!;
  }

  // 6. Update state
  ctx.replayWindow.update(index);
  ctx.index = index;
  ctx.rolloverCounter = roc;
  ctx.lastSeq = seq;

  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// SRTCP unprotect (RFC 3711 §3.4)
// ---------------------------------------------------------------------------

/**
 * Authenticate and decrypt an SRTCP packet.
 *
 * @returns Plaintext RTCP packet, or `null` if auth fails / replay detected.
 */
export function srtcpUnprotect(ctx: SrtcpContext, srtcpPacket: Buffer): Buffer | null {
  const tl = tagLength(ctx.profile);

  // Minimum: 8 bytes RTCP header + 4 bytes E|index + tl bytes tag
  if (srtcpPacket.length < 8 + 4 + tl) return null;

  // 1. Extract E || SRTCP_index (4 bytes before the auth tag)
  const eSrtcpIndexOffset = srtcpPacket.length - tl - 4;
  const eSrtcpIndex = srtcpPacket.readUInt32BE(eSrtcpIndexOffset);
  const encrypted = (eSrtcpIndex & 0x80000000) !== 0;
  const index = eSrtcpIndex & 0x7fffffff;

  // 2. Replay check
  if (!ctx.replayWindow.check(BigInt(index))) return null;

  // 3. Auth tag verification
  // Auth input = packet bytes (everything except the tag itself)
  const packetForAuth = srtcpPacket.subarray(0, eSrtcpIndexOffset); // header + encrypted body
  const receivedTag = srtcpPacket.subarray(srtcpPacket.length - tl);
  const expectedTag = computeSrtcpAuthTag(ctx.sessionAuthKey, packetForAuth, eSrtcpIndex, tl);
  if (!timingSafeEqual(expectedTag, receivedTag)) return null;

  // 4. Decrypt
  const header = srtcpPacket.subarray(0, 8);
  const encryptedRest = srtcpPacket.subarray(8, eSrtcpIndexOffset);

  let decryptedRest: Buffer;
  if (encrypted) {
    const ssrc = srtcpPacket.readUInt32BE(4);
    const iv = computeSrtcpIv(ctx.sessionSaltKey, ssrc, index);
    const keystream = aes128cmKeystream(ctx.sessionEncKey, iv, encryptedRest.length);
    decryptedRest = Buffer.allocUnsafe(encryptedRest.length);
    for (let i = 0; i < encryptedRest.length; i++) {
      decryptedRest[i] = encryptedRest[i]! ^ keystream[i]!;
    }
  } else {
    decryptedRest = encryptedRest;
  }

  // 5. Update state
  ctx.replayWindow.update(BigInt(index));
  ctx.index = index;

  return Buffer.concat([header, decryptedRest]);
}
