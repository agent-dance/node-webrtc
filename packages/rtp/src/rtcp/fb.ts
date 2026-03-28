/**
 * RTCP Feedback messages — RFC 4585
 *
 * Transport Layer Feedback (PT=205):
 *   FMT=1  NACK (Generic NACK)
 *   FMT=15 TWCC (Transport-wide CC) — not fully implemented here
 *
 * Payload-Specific Feedback (PT=206):
 *   FMT=1  PLI  (Picture Loss Indication)
 *   FMT=4  FIR  (Full Intra Request)
 *   FMT=15 REMB (Receiver Estimated Max Bitrate, draft-alvestrand-rmcat-remb)
 */

import type { RtcpNack, RtcpPli, RtcpFir, FirEntry, RtcpRemb } from '../types.js';

/** Common feedback header size: 4 (common) + 4 (senderSSRC) + 4 (mediaSSRC) = 12 bytes */
const FB_HEADER_SIZE = 12;

// ---------------------------------------------------------------------------
// NACK — RFC 4585 Section 6.2.1, PT=205, FMT=1
// ---------------------------------------------------------------------------

export function encodeNack(nack: RtcpNack): Buffer {
  // FCI = PID (16 bits) + BLP (16 bits) = 4 bytes
  const totalBytes = FB_HEADER_SIZE + 4;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | 1; // V=2, P=0, FMT=1
  buf[1] = 205;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);
  buf.writeUInt32BE(nack.senderSsrc >>> 0, 4);
  buf.writeUInt32BE(nack.mediaSsrc >>> 0, 8);
  buf.writeUInt16BE(nack.pid & 0xffff, 12);
  buf.writeUInt16BE(nack.blp & 0xffff, 14);

  return buf;
}

export function decodeNack(buf: Buffer): RtcpNack {
  if (buf.length < FB_HEADER_SIZE + 4) {
    throw new RangeError(`NACK packet too short: ${buf.length}`);
  }
  const senderSsrc = buf.readUInt32BE(4);
  const mediaSsrc = buf.readUInt32BE(8);
  const pid = buf.readUInt16BE(12);
  const blp = buf.readUInt16BE(14);
  return { senderSsrc, mediaSsrc, pid, blp };
}

// ---------------------------------------------------------------------------
// PLI — RFC 4585 Section 6.3.1, PT=206, FMT=1
// ---------------------------------------------------------------------------

export function encodePli(pli: RtcpPli): Buffer {
  // No FCI
  const totalBytes = FB_HEADER_SIZE;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | 1; // V=2, P=0, FMT=1
  buf[1] = 206;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);
  buf.writeUInt32BE(pli.senderSsrc >>> 0, 4);
  buf.writeUInt32BE(pli.mediaSsrc >>> 0, 8);

  return buf;
}

export function decodePli(buf: Buffer): RtcpPli {
  if (buf.length < FB_HEADER_SIZE) {
    throw new RangeError(`PLI packet too short: ${buf.length}`);
  }
  const senderSsrc = buf.readUInt32BE(4);
  const mediaSsrc = buf.readUInt32BE(8);
  return { senderSsrc, mediaSsrc };
}

// ---------------------------------------------------------------------------
// FIR — RFC 5104 Section 4.3.1, PT=206, FMT=4
// ---------------------------------------------------------------------------

/** Each FIR entry: 4 bytes SSRC + 4 bytes (seqNumber | reserved) */
const FIR_ENTRY_SIZE = 8;

export function encodeFir(fir: RtcpFir): Buffer {
  const totalBytes = FB_HEADER_SIZE + fir.entries.length * FIR_ENTRY_SIZE;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | 4; // V=2, P=0, FMT=4
  buf[1] = 206;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);
  buf.writeUInt32BE(fir.senderSsrc >>> 0, 4);
  buf.writeUInt32BE(0, 8); // media SSRC = 0 for FIR

  let offset = FB_HEADER_SIZE;
  for (const entry of fir.entries) {
    buf.writeUInt32BE(entry.ssrc >>> 0, offset);
    buf.writeUInt32BE((entry.seqNumber & 0xff) << 24, offset + 4);
    offset += FIR_ENTRY_SIZE;
  }

  return buf;
}

export function decodeFir(buf: Buffer): RtcpFir {
  if (buf.length < FB_HEADER_SIZE) {
    throw new RangeError(`FIR packet too short: ${buf.length}`);
  }
  const senderSsrc = buf.readUInt32BE(4);
  const entries: FirEntry[] = [];

  let offset = FB_HEADER_SIZE;
  while (offset + FIR_ENTRY_SIZE <= buf.length) {
    const ssrc = buf.readUInt32BE(offset);
    const seqNumber = (buf.readUInt32BE(offset + 4) >>> 24) & 0xff;
    entries.push({ ssrc, seqNumber });
    offset += FIR_ENTRY_SIZE;
  }

  return { senderSsrc, entries };
}

// ---------------------------------------------------------------------------
// REMB — draft-alvestrand-rmcat-remb, PT=206, FMT=15
// Unique ID: "REMB" in ASCII at FCI[0..3]
// ---------------------------------------------------------------------------

const REMB_UNIQUE_ID = Buffer.from('REMB', 'ascii');

export function encodeRemb(remb: RtcpRemb): Buffer {
  const ssrcCount = remb.ssrcs.length;
  // FCI: 4 (REMB) + 1 (numSSRC) + 3 (BR exp+mantissa) + ssrcCount*4
  const fciSize = 8 + ssrcCount * 4;
  const totalBytes = FB_HEADER_SIZE + fciSize;
  const buf = Buffer.allocUnsafe(totalBytes);

  buf[0] = (2 << 6) | 15; // V=2, P=0, FMT=15
  buf[1] = 206;
  buf.writeUInt16BE(totalBytes / 4 - 1, 2);
  buf.writeUInt32BE(remb.senderSsrc >>> 0, 4);
  buf.writeUInt32BE(remb.mediaSsrc >>> 0, 8);

  // "REMB" unique identifier
  REMB_UNIQUE_ID.copy(buf, 12);

  // Num SSRC (1 byte)
  buf[16] = ssrcCount & 0xff;

  // BR Exp (6 bits) + BR Mantissa (18 bits) = 24 bits
  // bitrate = mantissa * 2^exp
  const { exp, mantissa } = encodeBitrate(remb.bitrate);
  buf[17] = ((exp & 0x3f) << 2) | ((mantissa >> 16) & 0x03);
  buf[18] = (mantissa >> 8) & 0xff;
  buf[19] = mantissa & 0xff;

  let offset = 20;
  for (const ssrc of remb.ssrcs) {
    buf.writeUInt32BE(ssrc >>> 0, offset);
    offset += 4;
  }

  return buf;
}

function encodeBitrate(bitrate: number): { exp: number; mantissa: number } {
  if (bitrate === 0) return { exp: 0, mantissa: 0 };
  let exp = 0;
  let m = bitrate;
  while (m >= (1 << 18)) {
    m >>= 1;
    exp++;
  }
  return { exp, mantissa: m & 0x3ffff };
}

export function decodeRemb(buf: Buffer): RtcpRemb {
  if (buf.length < FB_HEADER_SIZE + 8) {
    throw new RangeError(`REMB packet too short: ${buf.length}`);
  }
  const senderSsrc = buf.readUInt32BE(4);
  const mediaSsrc = buf.readUInt32BE(8);

  // Verify "REMB" unique ID
  const uid = buf.subarray(12, 16).toString('ascii');
  if (uid !== 'REMB') {
    throw new Error(`Not a REMB packet, got unique ID: ${uid}`);
  }

  const numSsrc = buf[16]!;
  const byte17 = buf[17]!;
  const byte18 = buf[18]!;
  const byte19 = buf[19]!;

  const exp = (byte17 >> 2) & 0x3f;
  const mantissa = ((byte17 & 0x03) << 16) | (byte18 << 8) | byte19;
  const bitrate = mantissa * Math.pow(2, exp);

  const ssrcs: number[] = [];
  let offset = 20;
  for (let i = 0; i < numSsrc; i++) {
    if (offset + 4 > buf.length) break;
    ssrcs.push(buf.readUInt32BE(offset));
    offset += 4;
  }

  return { senderSsrc, mediaSsrc, bitrate, ssrcs };
}
