// Self-signed ECDSA certificate generation for DTLS
// Uses a minimal ASN.1/DER builder – no external dependencies.

import * as crypto from 'node:crypto';

export interface DtlsCertificate {
  cert: Buffer; // DER-encoded X.509
  privateKey: crypto.KeyObject;
  fingerprint: { algorithm: 'sha-256'; value: string };
}

// ─── ASN.1 / DER helpers ──────────────────────────────────────────────────────

function derLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  } else if (len < 0x100) {
    return Buffer.from([0x81, len]);
  } else if (len < 0x10000) {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    return Buffer.from([
      0x83,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function sequence(...contents: Buffer[]): Buffer {
  return tlv(0x30, ...contents);
}

function set_(...contents: Buffer[]): Buffer {
  return tlv(0x31, ...contents);
}

function integer(bytes: Buffer): Buffer {
  // Ensure positive integer (prepend 0x00 if high bit set)
  let val = bytes;
  if (val[0]! & 0x80) {
    val = Buffer.concat([Buffer.from([0x00]), val]);
  }
  return tlv(0x02, val);
}

function integerN(n: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeInt32BE(n, 0);
  // Trim leading zeros but keep at least 1 byte
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0 && !(buf[start + 1]! & 0x80)) {
    start++;
  }
  return integer(buf.subarray(start));
}

function oid(dotNotation: string): Buffer {
  const parts = dotNotation.split('.').map(Number);
  // First two components encoded as 40*a + b
  const encoded: number[] = [40 * parts[0]! + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i]!;
    const bytes: number[] = [];
    bytes.push(n & 0x7f);
    n >>= 7;
    while (n > 0) {
      bytes.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    encoded.push(...bytes);
  }
  return tlv(0x06, Buffer.from(encoded));
}

function utf8String(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, 'utf8'));
}

function utcTime(d: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = String(d.getUTCFullYear()).slice(2);
  const str =
    y +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(str, 'ascii'));
}

function bitString(bytes: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), bytes);
}

function octetString(bytes: Buffer): Buffer {
  return tlv(0x04, bytes);
}

function contextTag(n: number, ...contents: Buffer[]): Buffer {
  return tlv(0xa0 | n, ...contents);
}

// ─── Known OIDs ───────────────────────────────────────────────────────────────

// ecPublicKey: 1.2.840.10045.2.1
const OID_EC_PUBLIC_KEY = oid('1.2.840.10045.2.1');
// secp256r1 / P-256: 1.2.840.10045.3.1.7
const OID_P256 = oid('1.2.840.10045.3.1.7');
// ecdsa-with-SHA256: 1.2.840.10045.4.3.2
const OID_ECDSA_SHA256 = oid('1.2.840.10045.4.3.2');
// commonName: 2.5.4.3
const OID_COMMON_NAME = oid('2.5.4.3');
// subjectKeyIdentifier: 2.5.29.14
const OID_SKI = oid('2.5.29.14');

// ─── Certificate builder ──────────────────────────────────────────────────────

/**
 * Build a self-signed X.509 certificate in DER format.
 * Uses ECDSA P-256 with SHA-256.
 */
function buildSelfSignedCert(
  keyPair: crypto.KeyPairKeyObjectResult,
  commonNameValue: string,
  validityDays: number,
): Buffer {
  // Export public key as uncompressed EC point
  const jwk = keyPair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error('Not an EC key pair');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const coordSize = 32;
  const xPad = Buffer.alloc(coordSize);
  const yPad = Buffer.alloc(coordSize);
  x.copy(xPad, coordSize - x.length);
  y.copy(yPad, coordSize - y.length);
  const ecPoint = Buffer.concat([Buffer.from([0x04]), xPad, yPad]);

  // Dates
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60000); // 1 min ago
  const notAfter = new Date(now.getTime() + validityDays * 86400000);

  // Serial number (random 8 bytes)
  const serialBytes = crypto.randomBytes(8);
  // Ensure positive (clear high bit)
  serialBytes[0] = serialBytes[0]! & 0x7f;

  // Subject / Issuer RDN: CN=<commonName>
  const rdn = sequence(set_(sequence(OID_COMMON_NAME, utf8String(commonNameValue))));

  // SubjectPublicKeyInfo
  const spki = sequence(
    sequence(OID_EC_PUBLIC_KEY, OID_P256),
    bitString(ecPoint),
  );

  // Subject key identifier extension
  const skiValue = crypto.createHash('sha1').update(ecPoint).digest();
  const skiExtension = sequence(
    OID_SKI,
    octetString(octetString(skiValue)),
  );
  const extensions = contextTag(3, sequence(skiExtension));

  // TBSCertificate
  const tbs = sequence(
    contextTag(0, integerN(2)), // version: v3
    integer(serialBytes), // serialNumber
    sequence(OID_ECDSA_SHA256), // signature algorithm
    rdn, // issuer
    sequence(utcTime(notBefore), utcTime(notAfter)), // validity
    rdn, // subject
    spki, // subjectPublicKeyInfo
    extensions, // extensions
  );

  // Sign TBSCertificate
  const signature = crypto.sign('sha256', tbs, keyPair.privateKey);

  // Certificate = SEQUENCE { tbs, algorithm, signature }
  const cert = sequence(
    tbs,
    sequence(OID_ECDSA_SHA256),
    bitString(signature),
  );

  return cert;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 fingerprint of a DER certificate.
 * Returns colon-separated uppercase hex, e.g. "AA:BB:CC:..."
 */
export function computeFingerprint(certDer: Buffer): string {
  const hash = crypto.createHash('sha256').update(certDer).digest();
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/**
 * Verify that a DER certificate matches the expected fingerprint.
 */
export function verifyFingerprint(
  certDer: Buffer,
  expected: { algorithm: string; value: string },
): boolean {
  const algo = expected.algorithm.toLowerCase().replace('-', '');
  if (algo !== 'sha256') {
    throw new Error(`Unsupported fingerprint algorithm: ${expected.algorithm}`);
  }
  const actual = computeFingerprint(certDer);
  // Case-insensitive comparison
  return actual.toLowerCase() === expected.value.toLowerCase();
}

/**
 * Generate a self-signed ECDSA (P-256) certificate for use in DTLS.
 */
export function generateSelfSignedCertificate(): DtlsCertificate {
  const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cn = `dtls-${crypto.randomBytes(8).toString('hex')}`;
  const certDer = buildSelfSignedCert(keyPair, cn, 365);
  const fingerprint = computeFingerprint(certDer);

  return {
    cert: certDer,
    privateKey: keyPair.privateKey,
    fingerprint: { algorithm: 'sha-256', value: fingerprint },
  };
}

/**
 * Extract public key from DER-encoded certificate.
 * Parses the SubjectPublicKeyInfo to get the EC public key.
 */
export function extractPublicKeyFromCert(certDer: Buffer): crypto.KeyObject {
  // Use Node.js X509Certificate (available since Node 15.6)
  const x509 = new crypto.X509Certificate(certDer);
  return x509.publicKey;
}
