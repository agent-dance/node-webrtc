/**
 * RTP header extension parsing and serialization.
 * Supports one-byte header (RFC 5285, profile 0xBEDE) and
 * two-byte header (RFC 5285, profile 0x1000).
 */

import type { RtpExtensionValue, RtpHeaderExtension } from './types.js';

export const ONE_BYTE_PROFILE = 0xbede;
export const TWO_BYTE_PROFILE = 0x1000;

/**
 * Parse the extension payload (after the 4-byte profile+length header).
 * @param profile - The extension profile value (0xBEDE or 0x1000)
 * @param data    - Raw bytes of the extension body (without the 4-byte profile/length header)
 */
export function parseExtensionValues(
  profile: number,
  data: Buffer,
): RtpExtensionValue[] {
  const values: RtpExtensionValue[] = [];

  if (profile === ONE_BYTE_PROFILE) {
    // One-byte header: | 0001 | id(4) | len-1(4) | data ... |
    let i = 0;
    while (i < data.length) {
      const byte = data[i];
      if (byte === undefined) break;
      if (byte === 0x00) {
        // Padding
        i++;
        continue;
      }
      if (byte === 0xff) {
        // End marker
        break;
      }
      const id = (byte >> 4) & 0x0f;
      const len = (byte & 0x0f) + 1;
      i++;
      if (i + len > data.length) break;
      values.push({ id, data: Buffer.from(data.subarray(i, i + len)) });
      i += len;
    }
  } else if ((profile & 0xfff0) === TWO_BYTE_PROFILE) {
    // Two-byte header: | id(8) | len(8) | data ... |
    let i = 0;
    while (i < data.length) {
      const id = data[i];
      if (id === undefined) break;
      if (id === 0x00) {
        // Padding
        i++;
        continue;
      }
      i++;
      if (i >= data.length) break;
      const len = data[i];
      if (len === undefined) break;
      i++;
      if (len === 0) {
        values.push({ id, data: Buffer.alloc(0) });
        continue;
      }
      if (i + len > data.length) break;
      values.push({ id, data: Buffer.from(data.subarray(i, i + len)) });
      i += len;
    }
  }

  return values;
}

/**
 * Serialize extension values into a Buffer (without the 4-byte profile/length header).
 * The result is padded to a 4-byte boundary.
 */
export function serializeExtensionValues(
  profile: number,
  values: RtpExtensionValue[],
): Buffer {
  const parts: Buffer[] = [];

  if (profile === ONE_BYTE_PROFILE) {
    for (const ext of values) {
      const len = ext.data.length;
      if (len < 1 || len > 16) {
        throw new RangeError(
          `One-byte extension id=${ext.id}: data length must be 1-16 bytes, got ${len}`,
        );
      }
      if (ext.id < 1 || ext.id > 14) {
        throw new RangeError(
          `One-byte extension id must be 1-14, got ${ext.id}`,
        );
      }
      const header = ((ext.id & 0x0f) << 4) | ((len - 1) & 0x0f);
      parts.push(Buffer.from([header]));
      parts.push(Buffer.from(ext.data));
    }
  } else if ((profile & 0xfff0) === TWO_BYTE_PROFILE) {
    for (const ext of values) {
      const len = ext.data.length;
      if (ext.id < 1 || ext.id > 255) {
        throw new RangeError(
          `Two-byte extension id must be 1-255, got ${ext.id}`,
        );
      }
      parts.push(Buffer.from([ext.id, len]));
      if (len > 0) parts.push(Buffer.from(ext.data));
    }
  }

  const body = Buffer.concat(parts);
  // Pad to 4-byte boundary
  const padLen = (4 - (body.length % 4)) % 4;
  const padding = Buffer.alloc(padLen, 0x00);
  return Buffer.concat([body, padding]);
}

/**
 * Serialize a complete RtpHeaderExtension (profile/length word + body).
 */
export function serializeExtension(ext: RtpHeaderExtension): Buffer {
  const body = serializeExtensionValues(ext.id, ext.values);
  // Length field = number of 32-bit words in the body
  const lengthWords = body.length / 4;
  const header = Buffer.allocUnsafe(4);
  header.writeUInt16BE(ext.id, 0);
  header.writeUInt16BE(lengthWords, 2);
  return Buffer.concat([header, body]);
}

/**
 * Get the first extension value matching a given id, or undefined.
 */
export function getExtensionValue(
  ext: RtpHeaderExtension,
  id: number,
): RtpExtensionValue | undefined {
  return ext.values.find((v) => v.id === id);
}

/**
 * Return a new RtpHeaderExtension with the given id set (inserted or replaced).
 */
export function setExtensionValue(
  ext: RtpHeaderExtension,
  value: RtpExtensionValue,
): RtpHeaderExtension {
  const filtered = ext.values.filter((v) => v.id !== value.id);
  return { id: ext.id, values: [...filtered, value] };
}
