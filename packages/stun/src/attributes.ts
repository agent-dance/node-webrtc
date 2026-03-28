import * as crypto from 'node:crypto';
import { STUN_MAGIC_COOKIE, type ErrorCode, type MappedAddress, type XorMappedAddress } from './types.js';

// ---------------------------------------------------------------------------
// CRC32 – inline implementation (no external deps)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// XOR-MAPPED-ADDRESS  (RFC 5389 §15.2)
// ---------------------------------------------------------------------------

export function encodeXorMappedAddress(
  addr: XorMappedAddress,
  transactionId: Buffer,
): Buffer {
  if (addr.family === 4) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0x00, 0);           // reserved
    buf.writeUInt8(0x01, 1);           // family IPv4
    const xoredPort = addr.port ^ (STUN_MAGIC_COOKIE >>> 16);
    buf.writeUInt16BE(xoredPort, 2);

    const parts = addr.address.split('.').map(Number);
    const ipNum =
      ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>>
      0;
    const xoredIp = (ipNum ^ STUN_MAGIC_COOKIE) >>> 0;
    buf.writeUInt32BE(xoredIp, 4);
    return buf;
  } else {
    // IPv6
    const buf = Buffer.alloc(20);
    buf.writeUInt8(0x00, 0);
    buf.writeUInt8(0x02, 1);           // family IPv6
    const xoredPort = addr.port ^ (STUN_MAGIC_COOKIE >>> 16);
    buf.writeUInt16BE(xoredPort, 2);

    // Build 16-byte XOR mask: magic cookie (4 bytes) + transaction id (12 bytes)
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
    transactionId.copy(mask, 4);

    const ipBytes = ipv6ToBytes(addr.address);
    for (let i = 0; i < 16; i++) {
      buf[4 + i] = ipBytes[i]! ^ mask[i]!;
    }
    return buf;
  }
}

export function decodeXorMappedAddress(
  buf: Buffer,
  transactionId: Buffer,
): XorMappedAddress {
  const family = buf.readUInt8(1);
  const xoredPort = buf.readUInt16BE(2);
  const port = xoredPort ^ (STUN_MAGIC_COOKIE >>> 16);

  if (family === 0x01) {
    const xoredIp = buf.readUInt32BE(4);
    const ip = (xoredIp ^ STUN_MAGIC_COOKIE) >>> 0;
    const address = [
      (ip >>> 24) & 0xff,
      (ip >>> 16) & 0xff,
      (ip >>> 8) & 0xff,
      ip & 0xff,
    ].join('.');
    return { family: 4, port, address };
  } else {
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
    transactionId.copy(mask, 4);

    const ipBytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      ipBytes[i] = buf[4 + i]! ^ mask[i]!;
    }
    const address = bytesToIpv6(ipBytes);
    return { family: 6, port, address };
  }
}

// ---------------------------------------------------------------------------
// MAPPED-ADDRESS  (RFC 5389 §15.1)
// ---------------------------------------------------------------------------

export function encodeMappedAddress(addr: MappedAddress): Buffer {
  if (addr.family === 4) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0x00, 0);
    buf.writeUInt8(0x01, 1);
    buf.writeUInt16BE(addr.port, 2);
    const parts = addr.address.split('.').map(Number);
    buf[4] = parts[0]!;
    buf[5] = parts[1]!;
    buf[6] = parts[2]!;
    buf[7] = parts[3]!;
    return buf;
  } else {
    const buf = Buffer.alloc(20);
    buf.writeUInt8(0x00, 0);
    buf.writeUInt8(0x02, 1);
    buf.writeUInt16BE(addr.port, 2);
    const ipBytes = ipv6ToBytes(addr.address);
    ipBytes.copy(buf, 4);
    return buf;
  }
}

export function decodeMappedAddress(buf: Buffer): MappedAddress {
  const family = buf.readUInt8(1);
  const port = buf.readUInt16BE(2);

  if (family === 0x01) {
    const address = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    return { family: 4, port, address };
  } else {
    const ipBytes = buf.subarray(4, 20);
    const address = bytesToIpv6(ipBytes);
    return { family: 6, port, address };
  }
}

// ---------------------------------------------------------------------------
// USERNAME  (RFC 5389 §15.3)
// ---------------------------------------------------------------------------

export function encodeUsername(username: string): Buffer {
  return Buffer.from(username, 'utf8');
}

export function decodeUsername(buf: Buffer): string {
  return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// MESSAGE-INTEGRITY  (RFC 5389 §15.4)
// ---------------------------------------------------------------------------

/**
 * Compute HMAC-SHA1 over the STUN message up to (but not including) the
 * MESSAGE-INTEGRITY attribute itself.  The length field in the header is
 * adjusted to cover all content up to and including the MI TLV.
 *
 * @param msgBuf  The full encoded message buffer (with a tentative length that
 *                already includes the MI attribute's 24 bytes).
 * @param key     HMAC key (e.g. password for short-term credentials).
 */
export function computeMessageIntegrity(msgBuf: Buffer, key: Buffer): Buffer {
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(msgBuf);
  return hmac.digest();
}

/**
 * Append a MESSAGE-INTEGRITY attribute to an already-encoded STUN message.
 *
 * The returned buffer is a new message with the attribute appended and the
 * header length field updated accordingly.
 *
 * NOTE: This function should be called with the message buffer that does NOT
 * yet contain the MESSAGE-INTEGRITY (or anything after it).
 */
export function encodeMessageIntegrity(key: Buffer): Buffer {
  // The real encoding must know the preceding bytes; so we export a helper
  // that the caller uses after encoding the rest of the message.
  // The function signature matches the spec: returns the 20-byte HMAC-SHA1
  // that the caller can embed.  The full message-aware variant is
  // computeMessageIntegrity().
  //
  // Because the caller cannot give us the message here, we return a
  // placeholder.  See computeMessageIntegrity() for the real computation.
  void key;
  throw new Error(
    'encodeMessageIntegrity requires the message buffer; use computeMessageIntegrity() directly.',
  );
}

export function verifyMessageIntegrity(msg: Buffer, key: Buffer): boolean {
  // Find the MESSAGE-INTEGRITY attribute
  let offset = 20;
  while (offset + 4 <= msg.length) {
    const attrType = msg.readUInt16BE(offset);
    const attrLen = msg.readUInt16BE(offset + 2);

    if (attrType === 0x0008 /* MessageIntegrity */) {
      if (attrLen !== 20) return false;
      const storedHmac = msg.subarray(offset + 4, offset + 4 + 20);

      // Rebuild message up to (but not including) this attribute,
      // with the length field set to include up to end of MI attribute.
      const miEnd = offset + 4 + 20;
      const adjustedLength = miEnd - 20; // attribute area length up to MI end
      const headerAndBody = Buffer.from(msg.subarray(0, offset));
      headerAndBody.writeUInt16BE(adjustedLength, 2);
      const computed = computeMessageIntegrity(headerAndBody, key);
      return crypto.timingSafeEqual(storedHmac, computed);
    }

    const pad = (4 - (attrLen % 4)) % 4;
    offset += 4 + attrLen + pad;
  }
  return false;
}

// ---------------------------------------------------------------------------
// FINGERPRINT  (RFC 5389 §15.5)
// ---------------------------------------------------------------------------

const FINGERPRINT_XOR = 0x5354554e;

/**
 * Compute the FINGERPRINT value for a message.
 *
 * @param msgBuf  Message bytes up to (not including) the FINGERPRINT TLV,
 *                with the length field already reflecting the final size
 *                (including the 8-byte FINGERPRINT TLV).
 */
export function computeFingerprint(msgBuf: Buffer): number {
  return (crc32(msgBuf) ^ FINGERPRINT_XOR) >>> 0;
}

export function encodeFingerprint(): Buffer {
  // Like encodeMessageIntegrity, the real computation requires the message.
  throw new Error(
    'encodeFingerprint requires the message buffer; use computeFingerprint() directly.',
  );
}

export function verifyFingerprint(msg: Buffer): boolean {
  let offset = 20;
  while (offset + 4 <= msg.length) {
    const attrType = msg.readUInt16BE(offset);
    const attrLen = msg.readUInt16BE(offset + 2);

    if (attrType === 0x8028 /* Fingerprint */) {
      if (attrLen !== 4) return false;
      const stored = msg.readUInt32BE(offset + 4);

      // Recompute CRC32 over bytes preceding the FINGERPRINT TLV,
      // with the length field adjusted to cover up to the end of FINGERPRINT.
      const fpEnd = offset + 4 + 4; // offset of first byte after fingerprint value
      const adjustedLength = fpEnd - 20;
      const preceding = Buffer.from(msg.subarray(0, offset));
      preceding.writeUInt16BE(adjustedLength, 2);
      const expected = computeFingerprint(preceding);
      return stored === expected;
    }

    const pad = (4 - (attrLen % 4)) % 4;
    offset += 4 + attrLen + pad;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PRIORITY  (RFC 8445 §16.1)
// ---------------------------------------------------------------------------

export function encodePriority(priority: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(priority >>> 0, 0);
  return buf;
}

export function decodePriority(buf: Buffer): number {
  return buf.readUInt32BE(0);
}

// ---------------------------------------------------------------------------
// USE-CANDIDATE  (RFC 8445 §16.1) – empty attribute
// ---------------------------------------------------------------------------

export function encodeUseCandidate(): Buffer {
  return Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// ICE-CONTROLLED / ICE-CONTROLLING  (RFC 8445 §16.1)
// ---------------------------------------------------------------------------

export function encodeIceControlled(tiebreaker: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(tiebreaker, 0);
  return buf;
}

export function encodeIceControlling(tiebreaker: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(tiebreaker, 0);
  return buf;
}

export function decodeIceTiebreaker(buf: Buffer): bigint {
  return buf.readBigUInt64BE(0);
}

// ---------------------------------------------------------------------------
// ERROR-CODE  (RFC 5389 §15.6)
// ---------------------------------------------------------------------------

export function encodeErrorCode(error: ErrorCode): Buffer {
  const reasonBytes = Buffer.from(error.reason, 'utf8');
  const buf = Buffer.alloc(4 + reasonBytes.length);
  buf.writeUInt16BE(0x0000, 0); // reserved
  const cls = Math.floor(error.code / 100) & 0x07;
  const num = error.code % 100;
  buf.writeUInt8(cls, 2);
  buf.writeUInt8(num, 3);
  reasonBytes.copy(buf, 4);
  return buf;
}

export function decodeErrorCode(buf: Buffer): ErrorCode {
  const cls = buf.readUInt8(2) & 0x07;
  const num = buf.readUInt8(3);
  const code = cls * 100 + num;
  const reason = buf.subarray(4).toString('utf8');
  return { code, reason };
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

function ipv6ToBytes(address: string): Buffer {
  // Expand :: notation
  const expanded = expandIpv6(address);
  const groups = expanded.split(':');
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i] ?? '0', 16);
    buf.writeUInt16BE(val, i * 2);
  }
  return buf;
}

function expandIpv6(address: string): string {
  if (address.includes('::')) {
    const [left, right] = address.split('::');
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    const middle = Array(missing).fill('0');
    return [...leftGroups, ...middle, ...rightGroups].join(':');
  }
  return address;
}

function bytesToIpv6(buf: Buffer | Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const b = buf instanceof Buffer ? buf : Buffer.from(buf);
    groups.push(b.readUInt16BE(i * 2).toString(16));
  }
  // Simple :: compression: find longest run of zeros
  return compressIpv6(groups);
}

function compressIpv6(groups: string[]): string {
  // Find longest consecutive run of '0'
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === '0') {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    return groups.join(':');
  }

  const before = groups.slice(0, bestStart).join(':');
  const after = groups.slice(bestStart + bestLen).join(':');
  return `${before}::${after}`;
}
