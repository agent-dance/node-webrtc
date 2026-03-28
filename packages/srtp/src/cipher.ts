import { createCipheriv } from 'node:crypto';

// ---------------------------------------------------------------------------
// AES-128-CM keystream  (RFC 3711 §4.1.1)
// ---------------------------------------------------------------------------

/**
 * Generate `length` bytes of AES-128-CM (Counter Mode) keystream.
 *
 * @param key    16-byte AES key
 * @param iv     16-byte IV (the initial counter block, lower 16 bits = 0)
 * @param length Number of keystream bytes to return
 */
export function aes128cmKeystream(key: Buffer, iv: Buffer, length: number): Buffer {
  if (key.length !== 16) throw new RangeError('AES-128-CM requires a 16-byte key');
  if (iv.length !== 16) throw new RangeError('AES-128-CM IV must be 16 bytes');

  // Encrypt a zero plaintext; CTR mode emits the keystream directly.
  const plaintext = Buffer.alloc(length, 0);
  const cipher = createCipheriv('aes-128-ctr', key, iv);
  const ks = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ks.subarray(0, length);
}

// ---------------------------------------------------------------------------
// IV computation for SRTP  (RFC 3711 §4.1)
// ---------------------------------------------------------------------------

/**
 * Compute the 128-bit SRTP IV:
 *   IV = (k_s * 2^16) XOR (SSRC * 2^64) XOR (index * 2^16)
 *
 * Bit-position reference (big-endian 128-bit / 16-byte buffer):
 *   k_s  * 2^16  → salt (14 bytes) placed at buffer bytes [2..15]
 *   SSRC * 2^64  → SSRC (4 bytes)  placed at buffer bytes [4..7]
 *   i    * 2^16  → index (6 bytes) placed at buffer bytes [8..13]
 */
export function computeSrtpIv(salt: Buffer, ssrc: number, index: bigint): Buffer {
  if (salt.length !== 14) throw new RangeError('SRTP salt must be 14 bytes');

  // Start from all zeros; copy salt into bytes [2..15].
  const iv = Buffer.alloc(16, 0);
  salt.copy(iv, 2);

  // XOR SSRC into bytes [4..7].
  iv.writeUInt32BE((iv.readUInt32BE(4) ^ (ssrc >>> 0)) >>> 0, 4);

  // XOR 48-bit index into bytes [8..13].
  // index high 32 bits → bytes [8..11], index low 16 bits → bytes [12..13].
  const idxHi = Number((index >> 16n) & 0xffffffffn);
  const idxLo = Number(index & 0xffffn);
  iv.writeUInt32BE((iv.readUInt32BE(8) ^ idxHi) >>> 0, 8);
  iv.writeUInt16BE((iv.readUInt16BE(12) ^ idxLo) & 0xffff, 12);

  return iv;
}

// ---------------------------------------------------------------------------
// IV computation for SRTCP  (RFC 3711 §4.1)
// ---------------------------------------------------------------------------

/**
 * Compute the 128-bit SRTCP IV.
 * Identical formula to SRTP; the SRTCP index is 31-bit.
 */
export function computeSrtcpIv(salt: Buffer, ssrc: number, index: number): Buffer {
  return computeSrtpIv(salt, ssrc, BigInt(index));
}
