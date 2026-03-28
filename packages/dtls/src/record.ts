// DTLS Record Layer encode/decode (RFC 6347 Section 4.1)
//
// Record header format (13 bytes):
//   1 byte  content type
//   2 bytes version (major, minor)
//   2 bytes epoch
//   6 bytes sequence number (48-bit)
//   2 bytes length

import { ContentType, type DtlsRecord, DTLS_VERSION_1_2 } from './types.js';

const RECORD_HEADER_SIZE = 13;

/**
 * Encode a single DTLS record into a Buffer.
 */
export function encodeRecord(record: DtlsRecord): Buffer {
  const buf = Buffer.allocUnsafe(RECORD_HEADER_SIZE + record.fragment.length);
  let offset = 0;

  buf.writeUInt8(record.contentType, offset);
  offset += 1;
  buf.writeUInt8(record.version.major, offset);
  offset += 1;
  buf.writeUInt8(record.version.minor, offset);
  offset += 1;
  buf.writeUInt16BE(record.epoch, offset);
  offset += 2;

  // 48-bit sequence number (big-endian)
  const seq = record.sequenceNumber;
  buf.writeUInt16BE(Number((seq >> 32n) & 0xffffn), offset);
  offset += 2;
  buf.writeUInt32BE(Number(seq & 0xffffffffn), offset);
  offset += 4;

  buf.writeUInt16BE(record.fragment.length, offset);
  offset += 2;

  record.fragment.copy(buf, offset);
  return buf;
}

/**
 * Decode one or more DTLS records from a UDP datagram.
 * A single datagram may contain multiple records.
 */
export function decodeRecords(buf: Buffer): DtlsRecord[] {
  const records: DtlsRecord[] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (buf.length - offset < RECORD_HEADER_SIZE) {
      break;
    }

    const contentType = buf.readUInt8(offset) as ContentType;
    offset += 1;
    const major = buf.readUInt8(offset);
    offset += 1;
    const minor = buf.readUInt8(offset);
    offset += 1;
    const epoch = buf.readUInt16BE(offset);
    offset += 2;

    const seqHigh = BigInt(buf.readUInt16BE(offset));
    offset += 2;
    const seqLow = BigInt(buf.readUInt32BE(offset));
    offset += 4;
    const sequenceNumber = (seqHigh << 32n) | seqLow;

    const length = buf.readUInt16BE(offset);
    offset += 2;

    if (buf.length - offset < length) {
      break;
    }

    const fragment = buf.subarray(offset, offset + length);
    offset += length;

    records.push({
      contentType,
      version: { major, minor },
      epoch,
      sequenceNumber,
      fragment: Buffer.from(fragment),
    });
  }

  return records;
}

/**
 * Returns true if the buffer looks like a DTLS packet.
 * Content type must be 20-63 and version bytes must match DTLS 1.x.
 */
export function isDtlsPacket(buf: Buffer): boolean {
  if (buf.length < RECORD_HEADER_SIZE) return false;
  const ct = buf.readUInt8(0);
  // ContentType: 20 (ChangeCipherSpec), 21 (Alert), 22 (Handshake), 23 (ApplicationData)
  if (ct < 20 || ct > 63) return false;
  const major = buf.readUInt8(1);
  const minor = buf.readUInt8(2);
  // DTLS 1.0 = {254, 255}, DTLS 1.2 = {254, 253}
  if (major !== 254) return false;
  if (minor !== 253 && minor !== 255) return false;
  return true;
}

/** Create a record with DTLS 1.2 version defaults */
export function makeRecord(
  contentType: ContentType,
  epoch: number,
  sequenceNumber: bigint,
  fragment: Buffer,
): DtlsRecord {
  return {
    contentType,
    version: DTLS_VERSION_1_2,
    epoch,
    sequenceNumber,
    fragment,
  };
}

export { ContentType };
