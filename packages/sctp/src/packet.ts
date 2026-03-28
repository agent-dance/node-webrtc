// SCTP packet codec – RFC 4960
// Encode/decode SCTP packets (common header + chunks)

import type { ChunkType } from './types.js';

// ---------------------------------------------------------------------------
// SCTP Common Header (RFC 4960 §3.1)
//   Source Port (16) | Dest Port (16) | Verification Tag (32) | Checksum (32)
// ---------------------------------------------------------------------------

export interface SctpCommonHeader {
  srcPort: number;
  dstPort: number;
  verificationTag: number;
  checksum: number;
}

export interface SctpChunk {
  type: number; // ChunkType
  flags: number;
  value: Buffer;
}

export interface SctpPacket {
  header: SctpCommonHeader;
  chunks: SctpChunk[];
}

// ---------------------------------------------------------------------------
// Adler-32 / CRC-32c checksum for SCTP
// RFC 4960 uses CRC-32c. We compute it with a pure-JS implementation.
// ---------------------------------------------------------------------------

// CRC-32c table
const CRC32C_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0x82f63b78 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32c(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32C_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Encode SCTP packet
// ---------------------------------------------------------------------------

export function encodeSctpPacket(packet: SctpPacket): Buffer {
  // Encode chunks first
  const chunkBuffers: Buffer[] = [];
  for (const chunk of packet.chunks) {
    const chunkLen = 4 + chunk.value.length;
    const padded = Math.ceil(chunkLen / 4) * 4;
    const buf = Buffer.alloc(padded, 0);
    buf[0] = chunk.type;
    buf[1] = chunk.flags;
    buf.writeUInt16BE(chunkLen, 2);
    chunk.value.copy(buf, 4);
    chunkBuffers.push(buf);
  }

  const chunksTotal = chunkBuffers.reduce((s, b) => s + b.length, 0);
  const packet_buf = Buffer.alloc(12 + chunksTotal);

  // Write common header (checksum = 0 initially)
  packet_buf.writeUInt16BE(packet.header.srcPort, 0);
  packet_buf.writeUInt16BE(packet.header.dstPort, 2);
  packet_buf.writeUInt32BE(packet.header.verificationTag, 4);
  packet_buf.writeUInt32BE(0, 8); // checksum placeholder

  let off = 12;
  for (const cb of chunkBuffers) {
    cb.copy(packet_buf, off);
    off += cb.length;
  }

  // Compute and write checksum in little-endian (usrsctp/libwebrtc convention)
  // RFC 4960 says network byte order, but all real SCTP stacks (Linux, usrsctp)
  // write CRC-32c in little-endian due to the reflected/LSB-first nature of the algorithm.
  const checksum = crc32c(packet_buf);
  packet_buf.writeUInt32LE(checksum, 8);

  return packet_buf;
}

// ---------------------------------------------------------------------------
// Decode SCTP packet
// ---------------------------------------------------------------------------

export function decodeSctpPacket(buf: Buffer): SctpPacket {
  if (buf.length < 12) throw new RangeError('SCTP packet too short');

  const header: SctpCommonHeader = {
    srcPort: buf.readUInt16BE(0),
    dstPort: buf.readUInt16BE(2),
    verificationTag: buf.readUInt32BE(4),
    checksum: buf.readUInt32BE(8),
  };

  const chunks: SctpChunk[] = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const type = buf[off]!;
    const flags = buf[off + 1]!;
    const length = buf.readUInt16BE(off + 2);
    if (length < 4 || off + length > buf.length) break;
    const value = buf.subarray(off + 4, off + length);
    chunks.push({ type, flags, value: Buffer.from(value) });
    // Skip to next chunk (4-byte aligned)
    off += Math.ceil(length / 4) * 4;
  }

  return { header, chunks };
}

// ---------------------------------------------------------------------------
// Encode DATA chunk value (RFC 4960 §3.3.1)
//   TSN (32) | SID (16) | SSN (16) | PPID (32) | payload
// ---------------------------------------------------------------------------

export interface SctpDataPayload {
  tsn: number;
  streamId: number;
  ssn: number;     // Stream Sequence Number
  ppid: number;
  userData: Buffer;
  beginning: boolean; // B flag
  ending: boolean;    // E flag
  unordered: boolean; // U flag
}

export function encodeDataChunk(data: SctpDataPayload): SctpChunk {
  const value = Buffer.allocUnsafe(12 + data.userData.length);
  value.writeUInt32BE(data.tsn, 0);
  value.writeUInt16BE(data.streamId, 4);
  value.writeUInt16BE(data.ssn, 6);
  value.writeUInt32BE(data.ppid, 8);
  data.userData.copy(value, 12);

  let flags = 0;
  if (data.unordered) flags |= 0x04;
  if (data.beginning) flags |= 0x02;
  if (data.ending) flags |= 0x01;

  return { type: 0 /* DATA */, flags, value };
}

export function decodeDataChunk(chunk: SctpChunk): SctpDataPayload {
  if (chunk.value.length < 12) throw new RangeError('DATA chunk too short');
  return {
    tsn: chunk.value.readUInt32BE(0),
    streamId: chunk.value.readUInt16BE(4),
    ssn: chunk.value.readUInt16BE(6),
    ppid: chunk.value.readUInt32BE(8),
    userData: Buffer.from(chunk.value.subarray(12)),
    beginning: !!(chunk.flags & 0x02),
    ending: !!(chunk.flags & 0x01),
    unordered: !!(chunk.flags & 0x04),
  };
}

// ---------------------------------------------------------------------------
// DCEP message encode/decode (RFC 8832)
// ---------------------------------------------------------------------------

export interface DcepOpen {
  type: 0x03; // DATA_CHANNEL_OPEN
  channelType: number;
  priority: number;
  reliabilityParam: number;
  label: string;
  protocol: string;
}

export interface DcepAck {
  type: 0x02; // DATA_CHANNEL_ACK
}

export function encodeDcepOpen(msg: DcepOpen): Buffer {
  const labelBuf = Buffer.from(msg.label, 'utf8');
  const protoBuf = Buffer.from(msg.protocol, 'utf8');
  const buf = Buffer.allocUnsafe(12 + labelBuf.length + protoBuf.length);
  buf[0] = 0x03; // DATA_CHANNEL_OPEN
  buf[1] = msg.channelType;
  buf.writeUInt16BE(msg.priority, 2);
  buf.writeUInt32BE(msg.reliabilityParam, 4);
  buf.writeUInt16BE(labelBuf.length, 8);
  buf.writeUInt16BE(protoBuf.length, 10);
  labelBuf.copy(buf, 12);
  protoBuf.copy(buf, 12 + labelBuf.length);
  return buf;
}

export function encodeDcepAck(): Buffer {
  return Buffer.from([0x02, 0x00, 0x00, 0x00]);
}

export function decodeDcep(buf: Buffer): DcepOpen | DcepAck {
  if (buf.length < 1) throw new RangeError('DCEP message too short');
  const msgType = buf[0]!;
  if (msgType === 0x02) {
    return { type: 0x02 };
  }
  if (msgType === 0x03) {
    if (buf.length < 12) throw new RangeError('DCEP OPEN too short');
    const channelType = buf[1]!;
    const priority = buf.readUInt16BE(2);
    const reliabilityParam = buf.readUInt32BE(4);
    const labelLen = buf.readUInt16BE(8);
    const protoLen = buf.readUInt16BE(10);
    const label = buf.subarray(12, 12 + labelLen).toString('utf8');
    const protocol = buf.subarray(12 + labelLen, 12 + labelLen + protoLen).toString('utf8');
    return { type: 0x03, channelType, priority, reliabilityParam, label, protocol };
  }
  throw new Error(`Unknown DCEP type: 0x${msgType.toString(16)}`);
}
