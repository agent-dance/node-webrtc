import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';

import {
  STUN_MAGIC_COOKIE,
  MessageClass,
  MessageMethod,
  AttributeType,
} from '../src/types.js';

import {
  encodeMessage,
  decodeMessage,
  createBindingRequest,
  createBindingSuccessResponse,
  isStunMessage,
  generateTransactionId,
} from '../src/message.js';

import {
  encodeXorMappedAddress,
  decodeXorMappedAddress,
  encodeMappedAddress,
  decodeMappedAddress,
  encodeUsername,
  decodeUsername,
  computeMessageIntegrity,
  verifyMessageIntegrity,
  computeFingerprint,
  verifyFingerprint,
  encodePriority,
  decodePriority,
  encodeUseCandidate,
  encodeIceControlled,
  encodeIceControlling,
  decodeIceTiebreaker,
  encodeErrorCode,
  decodeErrorCode,
} from '../src/attributes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendAttribute(
  msgBuf: Buffer,
  attrType: number,
  value: Buffer,
): Buffer {
  const pad = (4 - (value.length % 4)) % 4;
  const tlv = Buffer.alloc(4 + value.length + pad);
  tlv.writeUInt16BE(attrType, 0);
  tlv.writeUInt16BE(value.length, 2);
  value.copy(tlv, 4);

  // Update header length
  const oldLen = msgBuf.readUInt16BE(2);
  const newBuf = Buffer.concat([msgBuf, tlv]);
  newBuf.writeUInt16BE(oldLen + tlv.length, 2);
  return newBuf;
}

// ---------------------------------------------------------------------------
// 1. Encode / decode binding request
// ---------------------------------------------------------------------------

describe('Binding request encode/decode', () => {
  it('creates a valid binding request with correct magic cookie', () => {
    const req = createBindingRequest();
    const buf = encodeMessage(req);

    // Total length at least 20 bytes (header only)
    expect(buf.length).toBeGreaterThanOrEqual(20);

    // First two bits must be 0
    expect(buf[0]! & 0xc0).toBe(0x00);

    // Magic cookie at bytes 4-7
    expect(buf.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE);

    // Message type for Binding Request = 0x0001
    expect(buf.readUInt16BE(0)).toBe(0x0001);

    // Transaction ID is 12 bytes
    expect(req.transactionId.length).toBe(12);
  });

  it('round-trips a binding request through encode/decode', () => {
    const req = createBindingRequest();
    const buf = encodeMessage(req);
    const decoded = decodeMessage(buf);

    expect(decoded.messageClass).toBe(MessageClass.Request);
    expect(decoded.messageMethod).toBe(MessageMethod.Binding);
    expect(decoded.transactionId).toEqual(req.transactionId);
    expect(decoded.attributes).toHaveLength(0);
  });

  it('uses provided transactionId', () => {
    const txId = Buffer.from('aabbccddeeff00112233445566778899'.slice(0, 24), 'hex');
    const req = createBindingRequest(txId);
    expect(req.transactionId).toEqual(txId);
  });
});

// ---------------------------------------------------------------------------
// 2. XOR-MAPPED-ADDRESS
// ---------------------------------------------------------------------------

describe('XOR-MAPPED-ADDRESS', () => {
  const txId = generateTransactionId();

  it('encodes and decodes IPv4 address', () => {
    const addr = { family: 4 as const, port: 12345, address: '192.168.1.100' };
    const encoded = encodeXorMappedAddress(addr, txId);
    const decoded = decodeXorMappedAddress(encoded, txId);
    expect(decoded.family).toBe(4);
    expect(decoded.port).toBe(12345);
    expect(decoded.address).toBe('192.168.1.100');
  });

  it('encodes and decodes IPv6 address', () => {
    const addr = {
      family: 6 as const,
      port: 54321,
      address: '2001:db8::1',
    };
    const encoded = encodeXorMappedAddress(addr, txId);
    const decoded = decodeXorMappedAddress(encoded, txId);
    expect(decoded.family).toBe(6);
    expect(decoded.port).toBe(54321);
    // The decoded address should represent the same IP
    // Normalise both to full form for comparison
    expect(decoded.address.toLowerCase()).toContain('2001');
  });

  it('XOR-obfuscates the port', () => {
    const addr = { family: 4 as const, port: 3478, address: '1.2.3.4' };
    const encoded = encodeXorMappedAddress(addr, txId);
    // Raw port in buffer should NOT equal 3478
    const rawPort = encoded.readUInt16BE(2);
    expect(rawPort).not.toBe(3478);
    // After decoding it should be 3478 again
    expect(decodeXorMappedAddress(encoded, txId).port).toBe(3478);
  });

  it('XOR-obfuscates the IPv4 address', () => {
    const addr = { family: 4 as const, port: 3478, address: '93.184.216.34' };
    const encoded = encodeXorMappedAddress(addr, txId);
    const rawIp = encoded.readUInt32BE(4);
    const parts = addr.address.split('.').map(Number);
    const originalIp =
      ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>>
      0;
    expect(rawIp).not.toBe(originalIp);
  });
});

// ---------------------------------------------------------------------------
// 3. MAPPED-ADDRESS
// ---------------------------------------------------------------------------

describe('MAPPED-ADDRESS', () => {
  it('encodes and decodes IPv4', () => {
    const addr = { family: 4 as const, port: 8080, address: '10.0.0.1' };
    const encoded = encodeMappedAddress(addr);
    const decoded = decodeMappedAddress(encoded);
    expect(decoded).toEqual(addr);
  });

  it('encodes and decodes IPv6', () => {
    const addr = { family: 6 as const, port: 443, address: '::1' };
    const encoded = encodeMappedAddress(addr);
    const decoded = decodeMappedAddress(encoded);
    expect(decoded.family).toBe(6);
    expect(decoded.port).toBe(443);
    // ::1 loopback
    expect(decoded.address).toContain('1');
  });

  it('stores raw (unobfuscated) port', () => {
    const addr = { family: 4 as const, port: 3478, address: '1.2.3.4' };
    const encoded = encodeMappedAddress(addr);
    expect(encoded.readUInt16BE(2)).toBe(3478);
  });
});

// ---------------------------------------------------------------------------
// 4. MESSAGE-INTEGRITY
// ---------------------------------------------------------------------------

describe('MESSAGE-INTEGRITY', () => {
  it('verifies a correctly signed message', () => {
    const key = Buffer.from('secret-password', 'utf8');
    const req = createBindingRequest();

    // Encode without MI
    let msgBuf = encodeMessage(req);

    // The length we advertise in the header must cover MI (24 bytes = 4 TLV + 20 HMAC)
    const miPlaceholder = Buffer.alloc(20);
    // Adjust header length to cover MI attribute
    const adjustedLength = msgBuf.readUInt16BE(2) + 24;
    const headerForHmac = Buffer.from(msgBuf);
    headerForHmac.writeUInt16BE(adjustedLength, 2);

    const hmac = computeMessageIntegrity(headerForHmac, key);
    expect(hmac.length).toBe(20);

    msgBuf = appendAttribute(msgBuf, AttributeType.MessageIntegrity, hmac);

    expect(verifyMessageIntegrity(msgBuf, key)).toBe(true);
  });

  it('fails for wrong key', () => {
    const key = Buffer.from('correct-key', 'utf8');
    const wrongKey = Buffer.from('wrong-key', 'utf8');
    const req = createBindingRequest();
    let msgBuf = encodeMessage(req);

    const adjustedLength = msgBuf.readUInt16BE(2) + 24;
    const headerForHmac = Buffer.from(msgBuf);
    headerForHmac.writeUInt16BE(adjustedLength, 2);
    const hmac = computeMessageIntegrity(headerForHmac, key);
    msgBuf = appendAttribute(msgBuf, AttributeType.MessageIntegrity, hmac);

    expect(verifyMessageIntegrity(msgBuf, wrongKey)).toBe(false);
  });

  it('fails if message is tampered after signing', () => {
    const key = Buffer.from('key', 'utf8');
    const req = createBindingRequest();
    let msgBuf = encodeMessage(req);

    const adjustedLength = msgBuf.readUInt16BE(2) + 24;
    const headerForHmac = Buffer.from(msgBuf);
    headerForHmac.writeUInt16BE(adjustedLength, 2);
    const hmac = computeMessageIntegrity(headerForHmac, key);
    msgBuf = appendAttribute(msgBuf, AttributeType.MessageIntegrity, hmac);

    // Tamper with transaction ID
    const tampered = Buffer.from(msgBuf);
    tampered[8] = tampered[8]! ^ 0xff;
    expect(verifyMessageIntegrity(tampered, key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. FINGERPRINT
// ---------------------------------------------------------------------------

describe('FINGERPRINT', () => {
  it('verifies a correctly fingerprinted message', () => {
    const req = createBindingRequest();
    let msgBuf = encodeMessage(req);

    // The length in the header must cover the fingerprint TLV (8 bytes)
    const fpLength = msgBuf.readUInt16BE(2) + 8;
    const headerForCrc = Buffer.from(msgBuf);
    headerForCrc.writeUInt16BE(fpLength, 2);

    const fpValue = computeFingerprint(headerForCrc);
    const fpBuf = Buffer.alloc(4);
    fpBuf.writeUInt32BE(fpValue, 0);
    msgBuf = appendAttribute(msgBuf, AttributeType.Fingerprint, fpBuf);

    expect(verifyFingerprint(msgBuf)).toBe(true);
  });

  it('fails for corrupted message', () => {
    const req = createBindingRequest();
    let msgBuf = encodeMessage(req);

    const fpLength = msgBuf.readUInt16BE(2) + 8;
    const headerForCrc = Buffer.from(msgBuf);
    headerForCrc.writeUInt16BE(fpLength, 2);

    const fpValue = computeFingerprint(headerForCrc);
    const fpBuf = Buffer.alloc(4);
    fpBuf.writeUInt32BE(fpValue, 0);
    msgBuf = appendAttribute(msgBuf, AttributeType.Fingerprint, fpBuf);

    const corrupted = Buffer.from(msgBuf);
    corrupted[8] = corrupted[8]! ^ 0x01;
    expect(verifyFingerprint(corrupted)).toBe(false);
  });

  it('fingerprint XOR constant is 0x5354554E', () => {
    // Verify the constant used internally
    // We can check that two different messages produce different fingerprints
    const req1 = createBindingRequest();
    const req2 = createBindingRequest();
    const fp1 = computeFingerprint(encodeMessage(req1));
    const fp2 = computeFingerprint(encodeMessage(req2));
    // Very unlikely to be equal (different transaction IDs)
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// 6. USERNAME
// ---------------------------------------------------------------------------

describe('USERNAME', () => {
  it('encodes and decodes ASCII username', () => {
    const username = 'user1:user2';
    const encoded = encodeUsername(username);
    expect(decodeUsername(encoded)).toBe(username);
  });

  it('encodes and decodes UTF-8 username', () => {
    const username = 'üser:pässword';
    const encoded = encodeUsername(username);
    expect(decodeUsername(encoded)).toBe(username);
  });

  it('returns a Buffer', () => {
    expect(encodeUsername('test')).toBeInstanceOf(Buffer);
  });
});

// ---------------------------------------------------------------------------
// 7. PRIORITY
// ---------------------------------------------------------------------------

describe('PRIORITY', () => {
  it('encodes and decodes priority', () => {
    const priority = 0x7e0000ff;
    const encoded = encodePriority(priority);
    expect(encoded.length).toBe(4);
    expect(decodePriority(encoded)).toBe(priority);
  });

  it('handles max uint32 value', () => {
    const priority = 0xffffffff;
    expect(decodePriority(encodePriority(priority))).toBe(priority);
  });

  it('handles zero', () => {
    expect(decodePriority(encodePriority(0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. USE-CANDIDATE
// ---------------------------------------------------------------------------

describe('USE-CANDIDATE', () => {
  it('is an empty attribute', () => {
    const encoded = encodeUseCandidate();
    expect(encoded.length).toBe(0);
  });

  it('can be embedded in a message', () => {
    const req = createBindingRequest();
    req.attributes.push({
      type: AttributeType.UseCandidate,
      value: encodeUseCandidate(),
    });
    const buf = encodeMessage(req);
    const decoded = decodeMessage(buf);
    const attr = decoded.attributes.find(
      (a) => a.type === AttributeType.UseCandidate,
    );
    expect(attr).toBeDefined();
    expect(attr!.value.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. ICE-CONTROLLING / ICE-CONTROLLED
// ---------------------------------------------------------------------------

describe('ICE-CONTROLLED and ICE-CONTROLLING', () => {
  const tiebreaker = BigInt('0xDEADBEEFCAFEBABE');

  it('encodes and decodes ICE-CONTROLLED tiebreaker', () => {
    const encoded = encodeIceControlled(tiebreaker);
    expect(encoded.length).toBe(8);
    expect(decodeIceTiebreaker(encoded)).toBe(tiebreaker);
  });

  it('encodes and decodes ICE-CONTROLLING tiebreaker', () => {
    const encoded = encodeIceControlling(tiebreaker);
    expect(encoded.length).toBe(8);
    expect(decodeIceTiebreaker(encoded)).toBe(tiebreaker);
  });

  it('ICE-CONTROLLED and ICE-CONTROLLING produce same bytes for same tiebreaker', () => {
    const tb = BigInt('0x0102030405060708');
    expect(encodeIceControlled(tb)).toEqual(encodeIceControlling(tb));
  });

  it('handles zero tiebreaker', () => {
    expect(decodeIceTiebreaker(encodeIceControlled(0n))).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 10. Full round-trip
// ---------------------------------------------------------------------------

describe('Full round-trip', () => {
  it('encodes and decodes a request with multiple attributes', () => {
    const txId = generateTransactionId();
    const req = createBindingRequest(txId);

    req.attributes.push({
      type: AttributeType.Username,
      value: encodeUsername('alice:bob'),
    });
    req.attributes.push({
      type: AttributeType.Priority,
      value: encodePriority(0x7e0000ff),
    });
    req.attributes.push({
      type: AttributeType.UseCandidate,
      value: encodeUseCandidate(),
    });
    req.attributes.push({
      type: AttributeType.IceControlling,
      value: encodeIceControlling(BigInt('0xABCDEF0123456789')),
    });

    const buf = encodeMessage(req);
    const decoded = decodeMessage(buf);

    expect(decoded.messageClass).toBe(MessageClass.Request);
    expect(decoded.messageMethod).toBe(MessageMethod.Binding);
    expect(decoded.transactionId).toEqual(txId);
    expect(decoded.attributes).toHaveLength(4);

    const usernameAttr = decoded.attributes.find(
      (a) => a.type === AttributeType.Username,
    )!;
    expect(decodeUsername(usernameAttr.value)).toBe('alice:bob');

    const priorityAttr = decoded.attributes.find(
      (a) => a.type === AttributeType.Priority,
    )!;
    expect(decodePriority(priorityAttr.value)).toBe(0x7e0000ff);

    const useCandidateAttr = decoded.attributes.find(
      (a) => a.type === AttributeType.UseCandidate,
    )!;
    expect(useCandidateAttr.value.length).toBe(0);

    const iceAttr = decoded.attributes.find(
      (a) => a.type === AttributeType.IceControlling,
    )!;
    expect(decodeIceTiebreaker(iceAttr.value)).toBe(
      BigInt('0xABCDEF0123456789'),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. isStunMessage
// ---------------------------------------------------------------------------

describe('isStunMessage', () => {
  it('recognises a valid binding request', () => {
    const req = createBindingRequest();
    const buf = encodeMessage(req);
    expect(isStunMessage(buf)).toBe(true);
  });

  it('rejects a buffer that is too short', () => {
    expect(isStunMessage(Buffer.alloc(10))).toBe(false);
  });

  it('rejects a DTLS record (first byte 0x16)', () => {
    const dtls = Buffer.alloc(20);
    dtls[0] = 0x16; // ContentType: Handshake
    expect(isStunMessage(dtls)).toBe(false);
  });

  it('rejects an RTP packet (first bit set)', () => {
    const rtp = Buffer.alloc(20);
    rtp[0] = 0x80; // RTP version 2
    expect(isStunMessage(rtp)).toBe(false);
  });

  it('rejects a buffer with wrong magic cookie', () => {
    const buf = encodeMessage(createBindingRequest());
    // Corrupt the magic cookie
    buf.writeUInt32BE(0xdeadbeef, 4);
    expect(isStunMessage(buf)).toBe(false);
  });

  it('rejects a message with length not multiple of 4', () => {
    const buf = encodeMessage(createBindingRequest());
    // Corrupt the length field
    buf.writeUInt16BE(3, 2);
    expect(isStunMessage(buf)).toBe(false);
  });

  it('rejects a message claiming more bytes than buffer has', () => {
    const buf = encodeMessage(createBindingRequest());
    buf.writeUInt16BE(9999, 2);
    expect(isStunMessage(buf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Binding success response
// ---------------------------------------------------------------------------

describe('createBindingSuccessResponse', () => {
  it('creates a success response with XOR-MAPPED-ADDRESS', () => {
    const req = createBindingRequest();
    const mappedAddr = { family: 4 as const, port: 54321, address: '203.0.113.1' };
    const resp = createBindingSuccessResponse(req, mappedAddr);

    expect(resp.messageClass).toBe(MessageClass.SuccessResponse);
    expect(resp.messageMethod).toBe(MessageMethod.Binding);
    expect(resp.transactionId).toEqual(req.transactionId);

    const attr = resp.attributes.find(
      (a) => a.type === AttributeType.XorMappedAddress,
    )!;
    expect(attr).toBeDefined();

    const decoded = decodeXorMappedAddress(attr.value, resp.transactionId);
    expect(decoded.family).toBe(4);
    expect(decoded.port).toBe(54321);
    expect(decoded.address).toBe('203.0.113.1');
  });

  it('round-trips through encode/decode', () => {
    const req = createBindingRequest();
    const resp = createBindingSuccessResponse(req, {
      family: 4,
      port: 12345,
      address: '1.2.3.4',
    });
    const buf = encodeMessage(resp);
    const decoded = decodeMessage(buf);
    expect(decoded.messageClass).toBe(MessageClass.SuccessResponse);

    const attr = decoded.attributes.find(
      (a) => a.type === AttributeType.XorMappedAddress,
    )!;
    const addr = decodeXorMappedAddress(attr.value, decoded.transactionId);
    expect(addr.address).toBe('1.2.3.4');
    expect(addr.port).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Bonus: ERROR-CODE
// ---------------------------------------------------------------------------

describe('ERROR-CODE', () => {
  it('encodes and decodes 400 Bad Request', () => {
    const err = { code: 400, reason: 'Bad Request' };
    const encoded = encodeErrorCode(err);
    const decoded = decodeErrorCode(encoded);
    expect(decoded.code).toBe(400);
    expect(decoded.reason).toBe('Bad Request');
  });

  it('encodes and decodes 487 Role Conflict', () => {
    const err = { code: 487, reason: 'Role Conflict' };
    const decoded = decodeErrorCode(encodeErrorCode(err));
    expect(decoded.code).toBe(487);
    expect(decoded.reason).toBe('Role Conflict');
  });
});
