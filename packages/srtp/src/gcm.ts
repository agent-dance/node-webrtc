import { createCipheriv, createDecipheriv } from 'node:crypto';
import { SrtpContext } from './types.js';

// ---------------------------------------------------------------------------
// AES-128-GCM  (RFC 7714)
// ---------------------------------------------------------------------------

// GCM auth tag is always 16 bytes (128-bit).
const GCM_TAG_LENGTH = 16;
// GCM nonce/IV is 12 bytes.
const GCM_IV_LENGTH = 12;

/**
 * Build the 12-byte GCM IV from the 12-byte salt, SSRC, and packet index.
 *
 * RFC 7714 §8.1:
 *   IV = salt XOR (SSRC placed at bytes 4..7) XOR (index placed at bytes 4..11)
 *
 * More precisely for SRTP (48-bit index):
 *   - Bytes 0..3: salt[0..3] XOR 0 XOR 0   (no SSRC/index contribution)
 *   - Bytes 4..7: salt[4..7] XOR SSRC_be32 XOR index_hi32
 *   - Bytes 8..11: salt[8..11] XOR 0 XOR index_lo32
 *
 * Wait – GCM salt is typically 12 bytes, not 14.  When used inside the
 * standard AES-CM derivation pipeline the 14-byte session salt is trimmed
 * to 12 bytes by dropping the two trailing zero bytes (they were zero-padded
 * anyway in the PRF output, but in practice the caller passes the full 14).
 * We take the first 12 bytes of the supplied salt.
 */
function buildGcmIv(salt: Buffer, ssrc: number, index: bigint): Buffer {
  // Use first 12 bytes; remaining 2 are the PRF zero-padding.
  const iv = Buffer.alloc(GCM_IV_LENGTH, 0);
  salt.copy(iv, 0, 0, GCM_IV_LENGTH);

  // XOR SSRC into bytes 4..7
  iv.writeUInt32BE(iv.readUInt32BE(4) ^ (ssrc >>> 0), 4);

  // XOR 48-bit index (big-endian 6 bytes) into bytes 6..11.
  // Store index into a temporary 8-byte buffer; bytes [2..7] hold the 48-bit value.
  const idxBytes = Buffer.allocUnsafe(8);
  idxBytes.writeBigUInt64BE(index & 0xffffffffffffn, 0);
  // bytes 6..7 overlap with the SSRC field – XOR as a 16-bit word
  iv.writeUInt16BE(iv.readUInt16BE(6) ^ idxBytes.readUInt16BE(2), 6);
  // bytes 8..11 – XOR as a 32-bit word
  iv.writeUInt32BE(iv.readUInt32BE(8) ^ idxBytes.readUInt32BE(4), 8);

  return iv;
}

// ---------------------------------------------------------------------------
// Parse minimal RTP header to extract SSRC and payload offset
// ---------------------------------------------------------------------------

function parseRtpHeader(packet: Buffer): { ssrc: number; headerLen: number } {
  if (packet.length < 12) throw new RangeError('RTP packet too short');
  const cc = packet[0]! & 0x0f;
  const x = (packet[0]! & 0x10) !== 0;
  let headerLen = 12 + cc * 4;
  if (x) {
    if (packet.length < headerLen + 4) throw new RangeError('RTP header extension truncated');
    const extLen = packet.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLen * 4;
  }
  const ssrc = packet.readUInt32BE(8);
  return { ssrc, headerLen };
}

// ---------------------------------------------------------------------------
// GCM protect / unprotect
// ---------------------------------------------------------------------------

/**
 * Encrypt and authenticate an SRTP packet using AES-128-GCM.
 *
 * Packet layout after protection:
 *   RTP Header (AAD, unchanged) | Encrypted Payload | GCM Auth Tag (16 bytes)
 */
export function gcmSrtpProtect(ctx: SrtpContext, rtpPacket: Buffer): Buffer {
  const { ssrc, headerLen } = parseRtpHeader(rtpPacket);
  const seq = rtpPacket.readUInt16BE(2);

  // Compute packet index and update context state.
  const index = computeIndex(ctx, seq);

  const iv = buildGcmIv(ctx.sessionSaltKey, ssrc, index);
  const header = rtpPacket.subarray(0, headerLen);
  const payload = rtpPacket.subarray(headerLen);

  const cipher = createCipheriv('aes-128-gcm', ctx.sessionEncKey, iv);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Update context
  ctx.index = index;
  ctx.rolloverCounter = Number(index >> 16n) >>> 0;
  ctx.lastSeq = seq;

  return Buffer.concat([header, encrypted, tag]);
}

/**
 * Authenticate and decrypt a GCM-protected SRTP packet.
 * Returns null if authentication fails or replay is detected.
 */
export function gcmSrtpUnprotect(ctx: SrtpContext, srtpPacket: Buffer): Buffer | null {
  if (srtpPacket.length < 12 + GCM_TAG_LENGTH) return null;

  const { ssrc, headerLen } = parseRtpHeader(srtpPacket);
  const seq = srtpPacket.readUInt16BE(2);

  const index = estimateIndex(ctx, seq);

  if (!ctx.replayWindow.check(index)) return null;

  const header = srtpPacket.subarray(0, headerLen);
  const encryptedPayload = srtpPacket.subarray(headerLen, srtpPacket.length - GCM_TAG_LENGTH);
  const tag = srtpPacket.subarray(srtpPacket.length - GCM_TAG_LENGTH);

  const iv = buildGcmIv(ctx.sessionSaltKey, ssrc, index);

  try {
    const decipher = createDecipheriv('aes-128-gcm', ctx.sessionEncKey, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);

    ctx.replayWindow.update(index);
    ctx.index = index;
    ctx.rolloverCounter = Number(index >> 16n) >>> 0;
    ctx.lastSeq = seq;

    return Buffer.concat([header, decrypted]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index helpers (shared logic – duplicated from protect/unprotect to keep
// gcm.ts self-contained; in a real project you'd factor these out)
// ---------------------------------------------------------------------------

function computeIndex(ctx: SrtpContext, seq: number): bigint {
  if (ctx.lastSeq === -1) {
    return BigInt(ctx.rolloverCounter) << 16n | BigInt(seq);
  }
  const roc = BigInt(ctx.rolloverCounter);
  const lastSeq = ctx.lastSeq;

  // If seq wraps forward (65535 → 0), increment ROC
  if (seq < lastSeq && lastSeq - seq > 0x8000) {
    return (roc + 1n) << 16n | BigInt(seq);
  }
  return roc << 16n | BigInt(seq);
}

function estimateIndex(ctx: SrtpContext, seq: number): bigint {
  if (ctx.lastSeq === -1) {
    return BigInt(ctx.rolloverCounter) << 16n | BigInt(seq);
  }
  // RFC 3711 §3.3.1 index estimation
  const v = BigInt(ctx.rolloverCounter);
  const diff = seq - ctx.lastSeq;

  if (diff > 0x8000) {
    // seq is much less than lastSeq → different ROC (wrap back?)
    return (v === 0n ? 0n : v - 1n) << 16n | BigInt(seq);
  } else if (diff < -0x8000) {
    // seq is much greater → ROC incremented
    return (v + 1n) << 16n | BigInt(seq);
  }
  return v << 16n | BigInt(seq);
}
