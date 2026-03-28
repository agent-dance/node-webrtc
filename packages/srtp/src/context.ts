import { createCipheriv } from 'node:crypto';
import {
  ProtectionProfile,
  SrtpKeyingMaterial,
  SrtpContext,
  SrtcpContext,
} from './types.js';
import { aes128cmKeystream } from './cipher.js';
import { ReplayWindow } from './replay.js';

// ---------------------------------------------------------------------------
// AES-128-CM PRF  (RFC 3711 §4.3.1)
// ---------------------------------------------------------------------------

/**
 * Derive a session key using the AES-CM key derivation function.
 *
 * The PRF key is the master key; the PRF input (IV) is:
 *   PRF_input = master_salt XOR (label * 2^48) XOR (r * 2^???)
 *
 * For KDR=0 (the common case), r=0 and the second XOR term vanishes.
 * The label is placed at byte offset 7 in the 14-byte salt (bit position 48).
 *
 * RFC 3711 §4.3.1:
 *   x = label * 2^48  (label occupies bits 48-55 of the 112-bit salt field)
 *
 * @param masterKey  16-byte AES master key
 * @param masterSalt 14-byte master salt
 * @param label      0x00=enc, 0x01=auth, 0x02=salt
 * @param length     Desired output length in bytes
 * @param r          Key derivation rate index (default 0)
 */
export function deriveSessionKey(
  masterKey: Buffer,
  masterSalt: Buffer,
  label: number,
  length: number,
  r: bigint = 0n,
): Buffer {
  if (masterSalt.length !== 14) throw new RangeError('masterSalt must be 14 bytes');

  // Build the 112-bit (14-byte) x value, then zero-pad to 16 bytes (right-pad
  // with two 0x00 bytes) to form the IV for AES-CM.
  //
  // x = master_salt XOR (label << 48) XOR (r << kdr_shift)
  // For KDR = 0 the r term is zero.
  //
  // label << 48 places the label byte at offset 6 (0-indexed) in the 14-byte
  // big-endian integer.
  const x = Buffer.from(masterSalt);

  // XOR in label at byte offset 7 (label is at bit position 48 of the
  // 112-bit big-endian value, i.e. byte index 7 counting from the MSB).
  x.writeUInt8(x.readUInt8(7) ^ (label & 0xff), 7);

  // If r != 0 we XOR it into the low 8 bytes of x (bytes 6..13).
  // KDR=0 is the common case so this branch is rarely taken.
  if (r !== 0n) {
    for (let i = 0; i < 8; i++) {
      const shift = BigInt((7 - i) * 8);
      const off = 6 + i;
      x.writeUInt8(x.readUInt8(off) ^ Number((r >> shift) & 0xffn), off);
    }
  }

  // Zero-pad to 16 bytes (append two 0x00 bytes) → this is the AES-CM IV
  const iv = Buffer.alloc(16, 0);
  x.copy(iv, 0); // x occupies bytes 0..13; bytes 14,15 remain 0

  return aes128cmKeystream(masterKey, iv, length);
}

// ---------------------------------------------------------------------------
// Tag length helpers
// ---------------------------------------------------------------------------

function authTagLength(profile: ProtectionProfile): 10 | 4 {
  return profile === ProtectionProfile.AES_128_CM_HMAC_SHA1_32 ? 4 : 10;
}

// ---------------------------------------------------------------------------
// Context factories
// ---------------------------------------------------------------------------

/**
 * Derive all three SRTP session keys from the supplied master keying material
 * and return an initialised SrtpContext.
 */
export function createSrtpContext(material: SrtpKeyingMaterial): SrtpContext {
  const { masterKey, masterSalt, profile } = material;

  const sessionEncKey = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
  const sessionSaltKey = deriveSessionKey(masterKey, masterSalt, 0x02, 14);
  // Auth key is only meaningful for CM profiles; for GCM we still derive it
  // (harmless) but it won't be used for packet authentication.
  const sessionAuthKey = deriveSessionKey(masterKey, masterSalt, 0x01, 20);

  return {
    profile,
    sessionEncKey,
    sessionAuthKey,
    sessionSaltKey,
    index: 0n,
    rolloverCounter: 0,
    lastSeq: -1,
    replayWindow: new ReplayWindow(),
  };
}

/**
 * Derive all three SRTCP session keys and return an initialised SrtcpContext.
 */
export function createSrtcpContext(material: SrtpKeyingMaterial): SrtcpContext {
  const { masterKey, masterSalt, profile } = material;

  // SRTCP uses separate labels (same label values, different contexts per
  // spec; in practice the same KDF is used with the same master key/salt).
  const sessionEncKey = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
  const sessionSaltKey = deriveSessionKey(masterKey, masterSalt, 0x02, 14);
  const sessionAuthKey = deriveSessionKey(masterKey, masterSalt, 0x01, 20);

  return {
    profile,
    sessionEncKey,
    sessionAuthKey,
    sessionSaltKey,
    index: 0,
    replayWindow: new ReplayWindow(),
  };
}
