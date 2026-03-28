/**
 * RTP packet encode/decode — RFC 3550 Section 5.1
 */

import type { RtpPacket } from './types.js';
import {
  parseExtensionValues,
  serializeExtension,
  ONE_BYTE_PROFILE,
  TWO_BYTE_PROFILE,
} from './extension.js';

/** Minimum RTP header size (no CSRC, no extension) */
const RTP_MIN_HEADER = 12;

/**
 * Returns true if the buffer looks like an RTP packet:
 *   - version == 2
 *   - payload type NOT in the RTCP range 200–204
 *   - at least 12 bytes
 */
export function isRtpPacket(buf: Buffer): boolean {
  if (buf.length < RTP_MIN_HEADER) return false;
  const firstByte = buf[0];
  if (firstByte === undefined) return false;
  const version = (firstByte >> 6) & 0x03;
  if (version !== 2) return false;
  const secondByte = buf[1];
  if (secondByte === undefined) return false;
  // RTCP PT occupies the full second byte (200–207); check raw value, not masked
  if (secondByte >= 200 && secondByte <= 207) return false;
  return true;
}

/**
 * Decode an RTP packet from a Buffer.
 * Throws if the buffer is malformed or too short.
 */
export function decodeRtp(buf: Buffer): RtpPacket {
  if (buf.length < RTP_MIN_HEADER) {
    throw new RangeError(`RTP buffer too short: ${buf.length}`);
  }

  const byte0 = buf[0]!;
  const byte1 = buf[1]!;

  const version = (byte0 >> 6) & 0x03;
  if (version !== 2) {
    throw new Error(`Invalid RTP version: ${version}`);
  }

  const padding = Boolean(byte0 & 0x20);
  const hasExtension = Boolean(byte0 & 0x10);
  const csrcCount = byte0 & 0x0f;

  const marker = Boolean(byte1 & 0x80);
  const payloadType = byte1 & 0x7f;

  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let offset = RTP_MIN_HEADER;

  // CSRC list
  if (buf.length < offset + csrcCount * 4) {
    throw new RangeError('RTP buffer too short for CSRC list');
  }
  const csrcs: number[] = [];
  for (let i = 0; i < csrcCount; i++) {
    csrcs.push(buf.readUInt32BE(offset));
    offset += 4;
  }

  // Header extension
  let headerExtension: RtpPacket['headerExtension'];
  if (hasExtension) {
    if (buf.length < offset + 4) {
      throw new RangeError('RTP buffer too short for extension header');
    }
    const extProfile = buf.readUInt16BE(offset);
    const extLengthWords = buf.readUInt16BE(offset + 2);
    offset += 4;
    const extBodyLen = extLengthWords * 4;
    if (buf.length < offset + extBodyLen) {
      throw new RangeError('RTP buffer too short for extension body');
    }
    const extBody = buf.subarray(offset, offset + extBodyLen) as Buffer;
    offset += extBodyLen;

    const values = parseExtensionValues(extProfile, extBody);
    headerExtension = { id: extProfile, values };
  }

  // Payload
  let payloadEnd = buf.length;
  if (padding) {
    const padLen = buf[buf.length - 1]!;
    payloadEnd = buf.length - padLen;
  }
  const payload = Buffer.from(buf.subarray(offset, payloadEnd));

  const result: RtpPacket = {
    version: 2,
    padding,
    extension: hasExtension,
    csrcCount,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    csrcs,
    payload,
  };
  if (headerExtension !== undefined) {
    result.headerExtension = headerExtension;
  }
  return result;
}

/**
 * Encode an RTP packet into a Buffer.
 */
export function encodeRtp(packet: RtpPacket): Buffer {
  const csrcCount = packet.csrcs.length;

  // Build extension bytes if present
  let extBuf: Buffer = Buffer.alloc(0);
  if (packet.headerExtension) {
    extBuf = serializeExtension(packet.headerExtension);
  }

  // Build padding
  let padBuf: Buffer = Buffer.alloc(0);
  if (packet.padding) {
    // Add minimal 1-byte padding (caller controls actual padding amount via payload)
    // The last byte of padding holds the count.
    // We always emit padding as part of the payload in this implementation.
    // If the caller set padding=true the payload should already include it.
  }

  const headerLen = RTP_MIN_HEADER + csrcCount * 4;
  const totalLen = headerLen + extBuf.length + packet.payload.length + padBuf.length;
  const buf = Buffer.allocUnsafe(totalLen);

  const hasExt = packet.headerExtension !== undefined || packet.extension;

  const byte0 =
    (2 << 6) |
    (packet.padding ? 0x20 : 0) |
    (hasExt ? 0x10 : 0) |
    (csrcCount & 0x0f);
  const byte1 = ((packet.marker ? 1 : 0) << 7) | (packet.payloadType & 0x7f);

  buf[0] = byte0;
  buf[1] = byte1;
  buf.writeUInt16BE(packet.sequenceNumber, 2);
  buf.writeUInt32BE(packet.timestamp >>> 0, 4);
  buf.writeUInt32BE(packet.ssrc >>> 0, 8);

  let offset = RTP_MIN_HEADER;
  for (const csrc of packet.csrcs) {
    buf.writeUInt32BE(csrc >>> 0, offset);
    offset += 4;
  }

  if (extBuf.length > 0) {
    extBuf.copy(buf, offset);
    offset += extBuf.length;
  }

  packet.payload.copy(buf, offset);

  return buf;
}
