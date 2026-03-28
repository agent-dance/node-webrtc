import {
  AttributeType,
  MessageClass,
  MessageMethod,
  STUN_MAGIC_COOKIE,
  type StunAttribute,
  type StunMessage,
  type XorMappedAddress,
} from './types.js';
import { encodeXorMappedAddress } from './attributes.js';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * RFC 5389 §6 – STUN message type encoding.
 *
 * The 14-bit message type is laid out as:
 *   M11 M10 M9 M8 M7 C1 M6 M5 M4 C0 M3 M2 M1 M0
 *
 * where C1/C0 are class bits and M are method bits.
 */
function encodeMessageType(method: MessageMethod, cls: MessageClass): number {
  // method bits 0-3 → bits 0-3
  // class bit 0   → bit 4
  // method bits 4-6 → bits 5-7
  // class bit 1   → bit 8
  // method bits 7-11 → bits 9-13
  const m = method & 0x0fff;
  const c = cls & 0x0110;
  const c0 = (c >> 4) & 0x1; // class bit 0
  const c1 = (c >> 8) & 0x1; // class bit 1
  const m03 = m & 0x000f;
  const m46 = (m >> 4) & 0x0007;
  const m711 = (m >> 7) & 0x001f;

  return (m711 << 9) | (c1 << 8) | (m46 << 5) | (c0 << 4) | m03;
}

function decodeMessageType(type: number): {
  method: MessageMethod;
  cls: MessageClass;
} {
  const c0 = (type >> 4) & 0x1;
  const c1 = (type >> 8) & 0x1;
  const m03 = type & 0x000f;
  const m46 = (type >> 5) & 0x0007;
  const m711 = (type >> 9) & 0x001f;

  const method = (m711 << 7) | (m46 << 4) | m03;
  const cls = (c1 << 8) | (c0 << 4);

  return {
    method: method as MessageMethod,
    cls: cls as MessageClass,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateTransactionId(): Buffer {
  return crypto.randomBytes(12);
}

export function encodeMessage(msg: StunMessage): Buffer {
  // Encode each attribute into TLV form
  const attrBuffers: Buffer[] = [];
  for (const attr of msg.attributes) {
    const len = attr.value.length;
    const pad = (4 - (len % 4)) % 4;
    const tlv = Buffer.alloc(4 + len + pad);
    tlv.writeUInt16BE(attr.type, 0);
    tlv.writeUInt16BE(len, 2);
    attr.value.copy(tlv, 4);
    attrBuffers.push(tlv);
  }

  const attrsLength = attrBuffers.reduce((sum, b) => sum + b.length, 0);
  const header = Buffer.alloc(20);

  const msgType = encodeMessageType(msg.messageMethod, msg.messageClass);
  header.writeUInt16BE(msgType, 0);
  header.writeUInt16BE(attrsLength, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  msg.transactionId.copy(header, 8);

  return Buffer.concat([header, ...attrBuffers]);
}

export function decodeMessage(buf: Buffer): StunMessage {
  if (buf.length < 20) {
    throw new Error(`STUN message too short: ${buf.length} bytes`);
  }

  const msgType = buf.readUInt16BE(0);
  const msgLength = buf.readUInt16BE(2);
  const magic = buf.readUInt32BE(4);

  if (magic !== STUN_MAGIC_COOKIE) {
    throw new Error(`Invalid STUN magic cookie: 0x${magic.toString(16)}`);
  }

  if (buf.length < 20 + msgLength) {
    throw new Error(
      `STUN message truncated: expected ${20 + msgLength}, got ${buf.length}`,
    );
  }

  const transactionId = buf.subarray(8, 20);
  const { method, cls } = decodeMessageType(msgType);

  const attributes: StunAttribute[] = [];
  let offset = 20;
  const end = 20 + msgLength;

  while (offset < end) {
    if (offset + 4 > end) break;
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const pad = (4 - (attrLen % 4)) % 4;
    offset += 4;
    if (offset + attrLen > end) break;
    const value = Buffer.from(buf.subarray(offset, offset + attrLen));
    attributes.push({ type: attrType as AttributeType, value });
    offset += attrLen + pad;
  }

  return {
    messageClass: cls,
    messageMethod: method,
    transactionId: Buffer.from(transactionId),
    attributes,
  };
}

export function createBindingRequest(transactionId?: Buffer): StunMessage {
  return {
    messageClass: MessageClass.Request,
    messageMethod: MessageMethod.Binding,
    transactionId: transactionId ?? generateTransactionId(),
    attributes: [],
  };
}

export function createBindingSuccessResponse(
  request: StunMessage,
  mappedAddress: XorMappedAddress,
): StunMessage {
  const xorAttrValue = encodeXorMappedAddress(
    mappedAddress,
    request.transactionId,
  );
  return {
    messageClass: MessageClass.SuccessResponse,
    messageMethod: MessageMethod.Binding,
    transactionId: Buffer.from(request.transactionId),
    attributes: [
      {
        type: AttributeType.XorMappedAddress,
        value: xorAttrValue,
      },
    ],
  };
}

export function isStunMessage(buf: Buffer): boolean {
  if (buf.length < 20) return false;

  // First two bits must be 0 (RFC 5389 §6)
  if ((buf[0]! & 0xc0) !== 0x00) return false;

  // Magic cookie must match
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return false;

  // Declared length + 20 bytes header must be <= buffer size
  const declaredLength = buf.readUInt16BE(2);
  if (buf.length < 20 + declaredLength) return false;

  // Length must be a multiple of 4
  if (declaredLength % 4 !== 0) return false;

  return true;
}
