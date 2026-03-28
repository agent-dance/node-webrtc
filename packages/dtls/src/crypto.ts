// DTLS 1.2 Cryptographic primitives
// RFC 5246 (TLS 1.2) PRF with SHA-256, AES-GCM, ECDH

import * as crypto from 'node:crypto';

// ─── HMAC / PRF ───────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256
 */
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest() as Buffer;
}

/**
 * HMAC-SHA384
 */
export function hmacSha384(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha384', key).update(data).digest() as Buffer;
}

/**
 * P_hash function (RFC 5246 Section 5)
 * P_hash(secret, seed) = HMAC(secret, A(1) + seed) + HMAC(secret, A(2) + seed) + ...
 * where A(0) = seed, A(i) = HMAC(secret, A(i-1))
 */
function pHash(
  hmacFn: (key: Buffer, data: Buffer) => Buffer,
  secret: Buffer,
  seed: Buffer,
  length: number,
): Buffer {
  const output = Buffer.allocUnsafe(length);
  let written = 0;

  // A(1)
  let a = hmacFn(secret, seed);

  while (written < length) {
    const chunk = hmacFn(secret, Buffer.concat([a, seed]));
    const toCopy = Math.min(chunk.length, length - written);
    chunk.copy(output, written, 0, toCopy);
    written += toCopy;
    // A(i+1) = HMAC(secret, A(i))
    a = hmacFn(secret, a);
  }

  return output;
}

/**
 * DTLS 1.2 PRF (SHA-256 based, RFC 5246)
 * PRF(secret, label, seed) = P_SHA256(secret, label + seed)
 */
export function prf(secret: Buffer, label: string, seed: Buffer, length: number): Buffer {
  const labelBuf = Buffer.from(label, 'ascii');
  const combined = Buffer.concat([labelBuf, seed]);
  return pHash(hmacSha256, secret, combined, length);
}

/**
 * PRF with SHA-384 (for AES-256 cipher suites)
 */
export function prfSha384(secret: Buffer, label: string, seed: Buffer, length: number): Buffer {
  const labelBuf = Buffer.from(label, 'ascii');
  const combined = Buffer.concat([labelBuf, seed]);
  return pHash(hmacSha384, secret, combined, length);
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Compute master secret from pre-master secret.
 * master_secret = PRF(pre_master_secret, "master secret", ClientRandom + ServerRandom, 48)
 */
export function computeMasterSecret(
  preMasterSecret: Buffer,
  clientRandom: Buffer,
  serverRandom: Buffer,
): Buffer {
  const seed = Buffer.concat([clientRandom, serverRandom]);
  return prf(preMasterSecret, 'master secret', seed, 48);
}

export interface KeyBlock {
  clientWriteKey: Buffer;
  serverWriteKey: Buffer;
  clientWriteIv: Buffer;
  serverWriteIv: Buffer;
}

/**
 * Expand key material from master secret (RFC 5246 Section 6.3).
 * For AES-128-GCM: key_length=16, iv_length=4 (implicit part).
 * key_block = PRF(master_secret, "key expansion", ServerRandom + ClientRandom, ...)
 */
export function expandKeyMaterial(
  masterSecret: Buffer,
  clientRandom: Buffer,
  serverRandom: Buffer,
  keyLength: number = 16,
  ivLength: number = 4,
): KeyBlock {
  // NOTE: seed is ServerRandom + ClientRandom (reversed from master secret)
  const seed = Buffer.concat([serverRandom, clientRandom]);
  const totalLength = 2 * keyLength + 2 * ivLength;
  const keyBlock = prf(masterSecret, 'key expansion', seed, totalLength);

  let off = 0;
  const clientWriteKey = Buffer.from(keyBlock.subarray(off, off + keyLength));
  off += keyLength;
  const serverWriteKey = Buffer.from(keyBlock.subarray(off, off + keyLength));
  off += keyLength;
  const clientWriteIv = Buffer.from(keyBlock.subarray(off, off + ivLength));
  off += ivLength;
  const serverWriteIv = Buffer.from(keyBlock.subarray(off, off + ivLength));

  return { clientWriteKey, serverWriteKey, clientWriteIv, serverWriteIv };
}

/**
 * Export keying material (RFC 5705 / RFC 5764 Section 4.2).
 * Used to derive SRTP master keys from DTLS.
 * EKM = PRF(master_secret, label, ClientRandom + ServerRandom, length)
 */
export function exportKeyingMaterial(
  masterSecret: Buffer,
  clientRandom: Buffer,
  serverRandom: Buffer,
  label: string,
  length: number,
): Buffer {
  const seed = Buffer.concat([clientRandom, serverRandom]);
  return prf(masterSecret, label, seed, length);
}

// ─── AES-GCM ──────────────────────────────────────────────────────────────────

export interface AesGcmResult {
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * AES-128-GCM encrypt.
 * Returns ciphertext + 16-byte authentication tag.
 */
export function aesgcmEncrypt(
  key: Buffer,
  iv: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): AesGcmResult {
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, tag };
}

/**
 * AES-128-GCM decrypt.
 */
export function aesgcmDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── ECDH ─────────────────────────────────────────────────────────────────────

export interface EcdhKeyPair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

/**
 * Generate an ephemeral ECDH key pair on P-256 (secp256r1).
 */
export function generateEcdhKeyPair(): EcdhKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return { privateKey, publicKey };
}

/**
 * Compute ECDH pre-master secret from our private key and peer's public key bytes.
 * peerPublicKeyBytes: uncompressed EC point (0x04 + x + y, 65 bytes for P-256)
 */
export function computeEcdhPreMasterSecret(
  privateKey: crypto.KeyObject,
  peerPublicKeyBytes: Buffer,
): Buffer {
  const peerPublicKey = decodeEcPublicKey(peerPublicKeyBytes);
  return crypto.diffieHellman({ privateKey, publicKey: peerPublicKey }) as Buffer;
}

/**
 * Encode EC public key to uncompressed point format: 0x04 + x (32 bytes) + y (32 bytes)
 */
export function encodeEcPublicKey(publicKey: crypto.KeyObject): Buffer {
  // Export as raw uncompressed point via JWK
  const jwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error('Not an EC public key');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  // Pad to 32 bytes for P-256
  const coordSize = 32;
  const xPadded = Buffer.alloc(coordSize);
  const yPadded = Buffer.alloc(coordSize);
  x.copy(xPadded, coordSize - x.length);
  y.copy(yPadded, coordSize - y.length);

  const out = Buffer.allocUnsafe(1 + coordSize * 2);
  out[0] = 0x04; // uncompressed
  xPadded.copy(out, 1);
  yPadded.copy(out, 1 + coordSize);
  return out;
}

/**
 * Decode uncompressed EC point to a KeyObject (P-256).
 */
export function decodeEcPublicKey(bytes: Buffer): crypto.KeyObject {
  if (bytes[0] !== 0x04) {
    throw new Error('Only uncompressed EC points supported (0x04 prefix)');
  }
  const coordSize = (bytes.length - 1) / 2;
  const x = bytes.subarray(1, 1 + coordSize);
  const y = bytes.subarray(1 + coordSize);

  const jwk: crypto.JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: x.toString('base64url'),
    y: y.toString('base64url'),
  };

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Compute SHA-256 hash of data.
 */
export function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest() as Buffer;
}

/**
 * Sign data with ECDSA-SHA256 private key.
 * Returns DER-encoded signature.
 */
export function ecdsaSign(privateKey: crypto.KeyObject, data: Buffer): Buffer {
  return crypto.sign('sha256', data, privateKey) as Buffer;
}

/**
 * Verify ECDSA-SHA256 signature.
 */
export function ecdsaVerify(
  publicKey: crypto.KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  try {
    return crypto.verify('sha256', data, publicKey, signature);
  } catch {
    return false;
  }
}
