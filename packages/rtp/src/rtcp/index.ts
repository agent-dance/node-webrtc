/**
 * RTCP compound packet dispatch — RFC 3550 Section 6.1
 *
 * Compound RTCP packets are multiple RTCP packets concatenated together
 * in a single UDP datagram.
 */

import type { RtcpPacket, RtcpPacketType as RtcpPT } from '../types.js';
import { RtcpPacketType } from '../types.js';
import { encodeSr, decodeSr } from './sr.js';
import { encodeRr, decodeRr } from './rr.js';
import { encodeSdes, decodeSdes } from './sdes.js';
import { encodeBye, decodeBye } from './bye.js';
import {
  encodeNack,
  decodeNack,
  encodePli,
  decodePli,
  encodeFir,
  decodeFir,
  encodeRemb,
  decodeRemb,
} from './fb.js';

/**
 * Returns true if the buffer looks like an RTCP packet:
 *   - version == 2
 *   - payload type in 200–207
 *   - at least 4 bytes
 */
export function isRtcpPacket(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const byte0 = buf[0];
  if (byte0 === undefined) return false;
  const version = (byte0 >> 6) & 0x03;
  if (version !== 2) return false;
  const byte1 = buf[1];
  if (byte1 === undefined) return false;
  // RTCP PT is the full second byte value (200–207)
  return byte1 >= 200 && byte1 <= 207;
}

/**
 * Decode a (possibly compound) RTCP buffer into an array of RtcpPacket objects.
 */
export function decodeRtcp(buf: Buffer): RtcpPacket[] {
  const packets: RtcpPacket[] = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;

    const byte0 = buf[offset]!;
    const byte1 = buf[offset + 1]!;
    const lengthWords = buf.readUInt16BE(offset + 2);
    const packetByteLen = (lengthWords + 1) * 4;

    if (offset + packetByteLen > buf.length) {
      // Truncated — take what we have
      break;
    }

    const packetBuf = buf.subarray(offset, offset + packetByteLen) as Buffer;
    offset += packetByteLen;

    const pt: number = byte1; // RTCP PT occupies the full second byte (no marker bit)
    const fmt = byte0 & 0x1f; // lower 5 bits (also RC / SC / FMT)

    try {
      if (pt === RtcpPacketType.SR) {
        packets.push({ type: 'sr', packet: decodeSr(packetBuf) });
      } else if (pt === RtcpPacketType.RR) {
        packets.push({ type: 'rr', packet: decodeRr(packetBuf) });
      } else if (pt === RtcpPacketType.SDES) {
        packets.push({ type: 'sdes', packet: decodeSdes(packetBuf) });
      } else if (pt === RtcpPacketType.BYE) {
        packets.push({ type: 'bye', packet: decodeBye(packetBuf) });
      } else if (pt === RtcpPacketType.TransportFeedback) {
        // FMT=1: NACK
        if (fmt === 1) {
          packets.push({ type: 'nack', packet: decodeNack(packetBuf) });
        } else {
          packets.push({ type: 'unknown', raw: Buffer.from(packetBuf) });
        }
      } else if (pt === RtcpPacketType.PayloadFeedback) {
        if (fmt === 1) {
          packets.push({ type: 'pli', packet: decodePli(packetBuf) });
        } else if (fmt === 4) {
          packets.push({ type: 'fir', packet: decodeFir(packetBuf) });
        } else if (fmt === 15) {
          // Could be REMB — check unique identifier
          if (packetBuf.length >= 16 && packetBuf.subarray(12, 16).toString('ascii') === 'REMB') {
            packets.push({ type: 'remb', packet: decodeRemb(packetBuf) });
          } else {
            packets.push({ type: 'unknown', raw: Buffer.from(packetBuf) });
          }
        } else {
          packets.push({ type: 'unknown', raw: Buffer.from(packetBuf) });
        }
      } else {
        packets.push({ type: 'unknown', raw: Buffer.from(packetBuf) });
      }
    } catch {
      packets.push({ type: 'unknown', raw: Buffer.from(packetBuf) });
    }
  }

  return packets;
}

/**
 * Encode an array of RtcpPacket objects into a compound RTCP buffer.
 */
export function encodeRtcp(packets: RtcpPacket[]): Buffer {
  const parts: Buffer[] = [];

  for (const pkt of packets) {
    switch (pkt.type) {
      case 'sr':
        parts.push(encodeSr(pkt.packet));
        break;
      case 'rr':
        parts.push(encodeRr(pkt.packet));
        break;
      case 'sdes':
        parts.push(encodeSdes(pkt.packet));
        break;
      case 'bye':
        parts.push(encodeBye(pkt.packet));
        break;
      case 'nack':
        parts.push(encodeNack(pkt.packet));
        break;
      case 'pli':
        parts.push(encodePli(pkt.packet));
        break;
      case 'fir':
        parts.push(encodeFir(pkt.packet));
        break;
      case 'remb':
        parts.push(encodeRemb(pkt.packet));
        break;
      case 'unknown':
        parts.push(pkt.raw);
        break;
    }
  }

  return Buffer.concat(parts);
}
