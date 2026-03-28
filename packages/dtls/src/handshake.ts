// DTLS Handshake message types and encode/decode (RFC 6347 Section 4.2)
//
// Handshake message header (12 bytes):
//   1 byte  HandshakeType
//   3 bytes length
//   2 bytes message_seq
//   3 bytes fragment_offset
//   3 bytes fragment_length
//  [body]

import { DTLS_VERSION_1_2, type DtlsVersion } from './types.js';

export enum HandshakeType {
  HelloRequest = 0,
  ClientHello = 1,
  ServerHello = 2,
  HelloVerifyRequest = 3,
  Certificate = 11,
  ServerKeyExchange = 12,
  CertificateRequest = 13,
  ServerHelloDone = 14,
  CertificateVerify = 15,
  ClientKeyExchange = 16,
  Finished = 20,
}

export interface HandshakeMessage {
  msgType: HandshakeType;
  length: number;
  messageSeq: number;
  fragmentOffset: number;
  fragmentLength: number;
  body: Buffer;
}

export interface TlsExtension {
  type: number;
  data: Buffer;
}

export interface ClientHello {
  clientVersion: DtlsVersion;
  random: Buffer; // 32 bytes
  sessionId: Buffer; // 0-32 bytes
  cookie: Buffer; // 0-255 bytes
  cipherSuites: number[]; // 2 bytes each
  compressionMethods: number[];
  extensions: TlsExtension[];
}

export interface ServerHello {
  serverVersion: DtlsVersion;
  random: Buffer;
  sessionId: Buffer;
  cipherSuite: number;
  compressionMethod: number;
  extensions: TlsExtension[];
}

export interface HelloVerifyRequest {
  serverVersion: DtlsVersion;
  cookie: Buffer;
}

export interface ServerKeyExchange {
  // ECParameters curve_params  (named_curve, 2 bytes)
  // ECPoint      public_key     (1-byte length + bytes)
  // Signature    signature      (2-byte hash/sig algos + 2-byte length + bytes)
  curveType: number; // 3 = named_curve
  namedCurve: number; // 23 = secp256r1 / P-256
  publicKey: Buffer; // uncompressed EC point (65 bytes)
  signatureAlgorithm: { hash: number; signature: number };
  signature: Buffer;
}

export interface ClientKeyExchange {
  publicKey: Buffer; // uncompressed EC point
}

// Cipher suite values
export const CipherSuites = {
  TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 0xc02b,
  TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 0xc02f,
  TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: 0xc02c,
} as const;

// Extension type constants
export const ExtensionType = {
  UseSrtp: 0x000e,
  SupportedGroups: 0x000a, // formerly elliptic_curves
  EcPointFormats: 0x000b,
  SignatureAlgorithms: 0x000d,
  RenegotiationInfo: 0xff01,
} as const;

// Named curves
export const NamedCurve = {
  secp256r1: 23,
  secp384r1: 24,
} as const;

// SRTP protection profiles (RFC 5764)
export const SrtpProtectionProfile = {
  SRTP_AES128_CM_SHA1_80: 0x0001,
  SRTP_AES128_CM_SHA1_32: 0x0002,
} as const;

// ─── Handshake Message ────────────────────────────────────────────────────────

const HANDSHAKE_HEADER_SIZE = 12;

export function encodeHandshakeMessage(msg: HandshakeMessage): Buffer {
  const body = msg.body;
  const buf = Buffer.allocUnsafe(HANDSHAKE_HEADER_SIZE + body.length);
  let off = 0;

  buf.writeUInt8(msg.msgType, off);
  off += 1;
  // 3-byte length
  writeUInt24BE(buf, off, body.length);
  off += 3;
  buf.writeUInt16BE(msg.messageSeq, off);
  off += 2;
  // 3-byte fragment offset
  writeUInt24BE(buf, off, msg.fragmentOffset);
  off += 3;
  // 3-byte fragment length
  writeUInt24BE(buf, off, body.length);
  off += 3;

  body.copy(buf, off);
  return buf;
}

export function decodeHandshakeMessage(buf: Buffer): HandshakeMessage {
  if (buf.length < HANDSHAKE_HEADER_SIZE) {
    throw new Error(`Buffer too small for handshake message: ${buf.length}`);
  }
  let off = 0;
  const msgType = buf.readUInt8(off) as HandshakeType;
  off += 1;
  const length = readUInt24BE(buf, off);
  off += 3;
  const messageSeq = buf.readUInt16BE(off);
  off += 2;
  const fragmentOffset = readUInt24BE(buf, off);
  off += 3;
  const fragmentLength = readUInt24BE(buf, off);
  off += 3;

  if (buf.length < off + fragmentLength) {
    throw new Error('Handshake message body truncated');
  }
  const body = Buffer.from(buf.subarray(off, off + fragmentLength));

  return { msgType, length, messageSeq, fragmentOffset, fragmentLength, body };
}

// ─── ClientHello ──────────────────────────────────────────────────────────────

export function encodeClientHello(hello: ClientHello): Buffer {
  const parts: Buffer[] = [];

  // Version (2 bytes)
  const ver = Buffer.allocUnsafe(2);
  ver.writeUInt8(hello.clientVersion.major, 0);
  ver.writeUInt8(hello.clientVersion.minor, 1);
  parts.push(ver);

  // Random (32 bytes)
  parts.push(hello.random);

  // Session ID
  const sid = Buffer.allocUnsafe(1 + hello.sessionId.length);
  sid.writeUInt8(hello.sessionId.length, 0);
  hello.sessionId.copy(sid, 1);
  parts.push(sid);

  // Cookie
  const ck = Buffer.allocUnsafe(1 + hello.cookie.length);
  ck.writeUInt8(hello.cookie.length, 0);
  hello.cookie.copy(ck, 1);
  parts.push(ck);

  // Cipher suites
  const csLen = hello.cipherSuites.length * 2;
  const cs = Buffer.allocUnsafe(2 + csLen);
  cs.writeUInt16BE(csLen, 0);
  for (let i = 0; i < hello.cipherSuites.length; i++) {
    cs.writeUInt16BE(hello.cipherSuites[i]!, 2 + i * 2);
  }
  parts.push(cs);

  // Compression methods
  const cm = Buffer.allocUnsafe(1 + hello.compressionMethods.length);
  cm.writeUInt8(hello.compressionMethods.length, 0);
  for (let i = 0; i < hello.compressionMethods.length; i++) {
    cm.writeUInt8(hello.compressionMethods[i]!, 1 + i);
  }
  parts.push(cm);

  // Extensions
  if (hello.extensions.length > 0) {
    const extsBuf = encodeExtensions(hello.extensions);
    parts.push(extsBuf);
  }

  return Buffer.concat(parts);
}

export function decodeClientHello(buf: Buffer): ClientHello {
  let off = 0;

  const major = buf.readUInt8(off);
  off += 1;
  const minor = buf.readUInt8(off);
  off += 1;

  const random = Buffer.from(buf.subarray(off, off + 32));
  off += 32;

  const sidLen = buf.readUInt8(off);
  off += 1;
  const sessionId = Buffer.from(buf.subarray(off, off + sidLen));
  off += sidLen;

  const cookieLen = buf.readUInt8(off);
  off += 1;
  const cookie = Buffer.from(buf.subarray(off, off + cookieLen));
  off += cookieLen;

  const csLen = buf.readUInt16BE(off);
  off += 2;
  const cipherSuites: number[] = [];
  for (let i = 0; i < csLen; i += 2) {
    cipherSuites.push(buf.readUInt16BE(off + i));
  }
  off += csLen;

  const cmLen = buf.readUInt8(off);
  off += 1;
  const compressionMethods: number[] = [];
  for (let i = 0; i < cmLen; i++) {
    compressionMethods.push(buf.readUInt8(off + i));
  }
  off += cmLen;

  let extensions: TlsExtension[] = [];
  if (off < buf.length) {
    extensions = decodeExtensions(buf, off);
  }

  return {
    clientVersion: { major, minor },
    random,
    sessionId,
    cookie,
    cipherSuites,
    compressionMethods,
    extensions,
  };
}

// ─── ServerHello ──────────────────────────────────────────────────────────────

export function encodeServerHello(hello: ServerHello): Buffer {
  const parts: Buffer[] = [];

  const ver = Buffer.allocUnsafe(2);
  ver.writeUInt8(hello.serverVersion.major, 0);
  ver.writeUInt8(hello.serverVersion.minor, 1);
  parts.push(ver);

  parts.push(hello.random);

  const sid = Buffer.allocUnsafe(1 + hello.sessionId.length);
  sid.writeUInt8(hello.sessionId.length, 0);
  hello.sessionId.copy(sid, 1);
  parts.push(sid);

  const cs = Buffer.allocUnsafe(2);
  cs.writeUInt16BE(hello.cipherSuite, 0);
  parts.push(cs);

  const cm = Buffer.allocUnsafe(1);
  cm.writeUInt8(hello.compressionMethod, 0);
  parts.push(cm);

  if (hello.extensions.length > 0) {
    parts.push(encodeExtensions(hello.extensions));
  }

  return Buffer.concat(parts);
}

export function decodeServerHello(buf: Buffer): ServerHello {
  let off = 0;

  const major = buf.readUInt8(off);
  off += 1;
  const minor = buf.readUInt8(off);
  off += 1;

  const random = Buffer.from(buf.subarray(off, off + 32));
  off += 32;

  const sidLen = buf.readUInt8(off);
  off += 1;
  const sessionId = Buffer.from(buf.subarray(off, off + sidLen));
  off += sidLen;

  const cipherSuite = buf.readUInt16BE(off);
  off += 2;
  const compressionMethod = buf.readUInt8(off);
  off += 1;

  let extensions: TlsExtension[] = [];
  if (off < buf.length) {
    extensions = decodeExtensions(buf, off);
  }

  return {
    serverVersion: { major, minor },
    random,
    sessionId,
    cipherSuite,
    compressionMethod,
    extensions,
  };
}

// ─── HelloVerifyRequest ───────────────────────────────────────────────────────

export function encodeHelloVerifyRequest(hvr: HelloVerifyRequest): Buffer {
  const buf = Buffer.allocUnsafe(3 + hvr.cookie.length);
  buf.writeUInt8(hvr.serverVersion.major, 0);
  buf.writeUInt8(hvr.serverVersion.minor, 1);
  buf.writeUInt8(hvr.cookie.length, 2);
  hvr.cookie.copy(buf, 3);
  return buf;
}

export function decodeHelloVerifyRequest(buf: Buffer): HelloVerifyRequest {
  const major = buf.readUInt8(0);
  const minor = buf.readUInt8(1);
  const cookieLen = buf.readUInt8(2);
  const cookie = Buffer.from(buf.subarray(3, 3 + cookieLen));
  return { serverVersion: { major, minor }, cookie };
}

// ─── ServerKeyExchange ────────────────────────────────────────────────────────

export function encodeServerKeyExchange(ske: ServerKeyExchange): Buffer {
  // curve_type (1) + named_curve (2) + point_len (1) + point + hash_algo (1) + sig_algo (1) + sig_len (2) + sig
  const pkLen = ske.publicKey.length;
  const sigLen = ske.signature.length;
  const buf = Buffer.allocUnsafe(1 + 2 + 1 + pkLen + 1 + 1 + 2 + sigLen);
  let off = 0;
  buf.writeUInt8(ske.curveType, off++);
  buf.writeUInt16BE(ske.namedCurve, off);
  off += 2;
  buf.writeUInt8(pkLen, off++);
  ske.publicKey.copy(buf, off);
  off += pkLen;
  buf.writeUInt8(ske.signatureAlgorithm.hash, off++);
  buf.writeUInt8(ske.signatureAlgorithm.signature, off++);
  buf.writeUInt16BE(sigLen, off);
  off += 2;
  ske.signature.copy(buf, off);
  return buf;
}

export function decodeServerKeyExchange(buf: Buffer): ServerKeyExchange {
  let off = 0;
  const curveType = buf.readUInt8(off++);
  const namedCurve = buf.readUInt16BE(off);
  off += 2;
  const pkLen = buf.readUInt8(off++);
  const publicKey = Buffer.from(buf.subarray(off, off + pkLen));
  off += pkLen;
  const hash = buf.readUInt8(off++);
  const signature_ = buf.readUInt8(off++);
  const sigLen = buf.readUInt16BE(off);
  off += 2;
  const signature = Buffer.from(buf.subarray(off, off + sigLen));
  return {
    curveType,
    namedCurve,
    publicKey,
    signatureAlgorithm: { hash, signature: signature_ },
    signature,
  };
}

// ─── Certificate ──────────────────────────────────────────────────────────────

export function encodeCertificate(certDer: Buffer): Buffer {
  // CertificateList: 3-byte list length, then each cert: 3-byte cert length + DER
  const certLen = certDer.length;
  const listLen = 3 + certLen;
  const buf = Buffer.allocUnsafe(3 + listLen);
  writeUInt24BE(buf, 0, listLen);
  writeUInt24BE(buf, 3, certLen);
  certDer.copy(buf, 6);
  return buf;
}

export function decodeCertificate(buf: Buffer): Buffer[] {
  let off = 0;
  const listLen = readUInt24BE(buf, off);
  off += 3;
  const end = off + listLen;
  const certs: Buffer[] = [];
  while (off < end) {
    const certLen = readUInt24BE(buf, off);
    off += 3;
    certs.push(Buffer.from(buf.subarray(off, off + certLen)));
    off += certLen;
  }
  return certs;
}

// ─── ClientKeyExchange ────────────────────────────────────────────────────────

export function encodeClientKeyExchange(cke: ClientKeyExchange): Buffer {
  const buf = Buffer.allocUnsafe(1 + cke.publicKey.length);
  buf.writeUInt8(cke.publicKey.length, 0);
  cke.publicKey.copy(buf, 1);
  return buf;
}

export function decodeClientKeyExchange(buf: Buffer): ClientKeyExchange {
  const pkLen = buf.readUInt8(0);
  const publicKey = Buffer.from(buf.subarray(1, 1 + pkLen));
  return { publicKey };
}

// ─── Extensions ───────────────────────────────────────────────────────────────

function encodeExtensions(extensions: TlsExtension[]): Buffer {
  const parts: Buffer[] = [];
  for (const ext of extensions) {
    const hdr = Buffer.allocUnsafe(4);
    hdr.writeUInt16BE(ext.type, 0);
    hdr.writeUInt16BE(ext.data.length, 2);
    parts.push(hdr);
    parts.push(ext.data);
  }
  const extsBuf = Buffer.concat(parts);
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(extsBuf.length, 0);
  return Buffer.concat([len, extsBuf]);
}

function decodeExtensions(buf: Buffer, off: number): TlsExtension[] {
  if (off + 2 > buf.length) return [];
  const totalLen = buf.readUInt16BE(off);
  off += 2;
  const end = off + totalLen;
  const extensions: TlsExtension[] = [];
  while (off < end && off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off);
    off += 2;
    const dataLen = buf.readUInt16BE(off);
    off += 2;
    const data = Buffer.from(buf.subarray(off, off + dataLen));
    off += dataLen;
    extensions.push({ type, data });
  }
  return extensions;
}

// ─── Extension builders ───────────────────────────────────────────────────────

/**
 * Build use_srtp extension data (RFC 5764)
 * protection_profiles: list of 2-byte profile IDs
 */
export function buildUseSrtpExtension(profiles: number[]): Buffer {
  // 2-byte profiles list length + 2 bytes each + 1 byte MKI length (0)
  const listLen = profiles.length * 2;
  const buf = Buffer.allocUnsafe(2 + listLen + 1);
  buf.writeUInt16BE(listLen, 0);
  for (let i = 0; i < profiles.length; i++) {
    buf.writeUInt16BE(profiles[i]!, 2 + i * 2);
  }
  buf.writeUInt8(0, 2 + listLen); // MKI length = 0
  return buf;
}

export function parseSrtpProfiles(data: Buffer): number[] {
  if (data.length < 2) return [];
  const listLen = data.readUInt16BE(0);
  const profiles: number[] = [];
  for (let i = 0; i < listLen; i += 2) {
    if (2 + i + 1 < data.length) {
      profiles.push(data.readUInt16BE(2 + i));
    }
  }
  return profiles;
}

/**
 * Build supported_groups extension (named curves)
 */
export function buildSupportedGroupsExtension(curves: number[]): Buffer {
  const listLen = curves.length * 2;
  const buf = Buffer.allocUnsafe(2 + listLen);
  buf.writeUInt16BE(listLen, 0);
  for (let i = 0; i < curves.length; i++) {
    buf.writeUInt16BE(curves[i]!, 2 + i * 2);
  }
  return buf;
}

/**
 * Build signature_algorithms extension
 */
export function buildSignatureAlgorithmsExtension(
  pairs: Array<{ hash: number; sig: number }>,
): Buffer {
  const listLen = pairs.length * 2;
  const buf = Buffer.allocUnsafe(2 + listLen);
  buf.writeUInt16BE(listLen, 0);
  for (let i = 0; i < pairs.length; i++) {
    buf.writeUInt8(pairs[i]!.hash, 2 + i * 2);
    buf.writeUInt8(pairs[i]!.sig, 2 + i * 2 + 1);
  }
  return buf;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function writeUInt24BE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt8((value >> 16) & 0xff, offset);
  buf.writeUInt8((value >> 8) & 0xff, offset + 1);
  buf.writeUInt8(value & 0xff, offset + 2);
}

function readUInt24BE(buf: Buffer, offset: number): number {
  return (buf.readUInt8(offset) << 16) | (buf.readUInt8(offset + 1) << 8) | buf.readUInt8(offset + 2);
}

export { DTLS_VERSION_1_2 };
