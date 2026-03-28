/**
 * RTCP SDES (Source Description) — RFC 3550 Section 6.5
 */

import type { RtcpSdes, SdesChunk, SdesItem } from '../types.js';

/** SDES base header: 4 bytes (common header) */
const SDES_HEADER_SIZE = 4;

export function encodeSdes(sdes: RtcpSdes): Buffer {
  const chunkBuffers: Buffer[] = [];

  for (const chunk of sdes.chunks) {
    const itemParts: Buffer[] = [];

    // SSRC (4 bytes)
    const ssrcBuf = Buffer.allocUnsafe(4);
    ssrcBuf.writeUInt32BE(chunk.ssrc >>> 0, 0);
    itemParts.push(ssrcBuf);

    for (const item of chunk.items) {
      const textBuf = Buffer.from(item.text, 'utf8');
      const itemBuf = Buffer.allocUnsafe(2 + textBuf.length);
      itemBuf[0] = item.type & 0xff;
      itemBuf[1] = textBuf.length & 0xff;
      textBuf.copy(itemBuf, 2);
      itemParts.push(itemBuf);
    }

    // END item (type=0)
    itemParts.push(Buffer.from([0x00]));

    // Concatenate and pad to 4-byte boundary
    const chunkBody = Buffer.concat(itemParts);
    const padLen = (4 - (chunkBody.length % 4)) % 4;
    const padding = Buffer.alloc(padLen, 0x00);
    chunkBuffers.push(Buffer.concat([chunkBody, padding]));
  }

  const body = Buffer.concat(chunkBuffers);
  const totalBytes = SDES_HEADER_SIZE + body.length;

  const header = Buffer.allocUnsafe(SDES_HEADER_SIZE);
  const sc = sdes.chunks.length;
  header[0] = (2 << 6) | (sc & 0x1f);
  header[1] = 202;
  header.writeUInt16BE(totalBytes / 4 - 1, 2);

  return Buffer.concat([header, body]);
}

export function decodeSdes(buf: Buffer): RtcpSdes {
  if (buf.length < SDES_HEADER_SIZE) {
    throw new RangeError(`SDES packet too short: ${buf.length}`);
  }

  const sc = buf[0]! & 0x1f;
  // length word gives total 32-bit words - 1, so total bytes = (length+1)*4
  const totalBytes = (buf.readUInt16BE(2) + 1) * 4;

  const chunks: SdesChunk[] = [];
  let offset = SDES_HEADER_SIZE;

  for (let c = 0; c < sc; c++) {
    if (offset + 4 > buf.length) break;

    const ssrc = buf.readUInt32BE(offset);
    offset += 4;

    const items: SdesItem[] = [];

    while (offset < totalBytes && offset < buf.length) {
      const itemType = buf[offset];
      if (itemType === undefined || itemType === 0x00) {
        // END item — skip to 4-byte boundary
        offset++;
        const padTo = (offset + 3) & ~3;
        offset = Math.min(padTo, buf.length);
        break;
      }
      offset++;
      const textLen = buf[offset];
      if (textLen === undefined) break;
      offset++;
      const text = buf.subarray(offset, offset + textLen).toString('utf8');
      offset += textLen;
      items.push({ type: itemType, text });
    }

    chunks.push({ ssrc, items });
  }

  return { chunks };
}
