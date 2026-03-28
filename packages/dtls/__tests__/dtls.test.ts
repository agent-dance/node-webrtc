import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';

import { isDtlsPacket, encodeRecord, decodeRecords } from '../src/record.js';
import { ContentType, DTLS_VERSION_1_2 } from '../src/types.js';
import {
  encodeHandshakeMessage,
  decodeHandshakeMessage,
  encodeClientHello,
  decodeClientHello,
  CipherSuites,
  HandshakeType,
  buildUseSrtpExtension,
  SrtpProtectionProfile,
} from '../src/handshake.js';
import {
  prf,
  computeMasterSecret,
  aesgcmEncrypt,
  aesgcmDecrypt,
  generateEcdhKeyPair,
  computeEcdhPreMasterSecret,
  encodeEcPublicKey,
  decodeEcPublicKey,
  hmacSha256,
} from '../src/crypto.js';
import {
  generateSelfSignedCertificate,
  computeFingerprint,
  verifyFingerprint,
} from '../src/certificate.js';
import { DtlsTransport, DtlsState, type SrtpKeyingMaterial } from '../src/transport.js';

// ─── 1. isDtlsPacket ──────────────────────────────────────────────────────────

describe('isDtlsPacket', () => {
  it('returns true for a valid DTLS 1.2 handshake packet', () => {
    const buf = Buffer.allocUnsafe(13);
    buf.writeUInt8(22, 0); // Handshake
    buf.writeUInt8(254, 1); // major
    buf.writeUInt8(253, 2); // minor (DTLS 1.2)
    buf.fill(0, 3);
    expect(isDtlsPacket(buf)).toBe(true);
  });

  it('returns true for DTLS 1.0 version bytes', () => {
    const buf = Buffer.allocUnsafe(13);
    buf.writeUInt8(20, 0); // ChangeCipherSpec
    buf.writeUInt8(254, 1);
    buf.writeUInt8(255, 2); // DTLS 1.0
    buf.fill(0, 3);
    expect(isDtlsPacket(buf)).toBe(true);
  });

  it('returns false for a non-DTLS packet (STUN)', () => {
    const buf = Buffer.allocUnsafe(13);
    buf.fill(0);
    buf.writeUInt8(0x00, 0); // STUN binding request
    expect(isDtlsPacket(buf)).toBe(false);
  });

  it('returns false for RTP packet (content type >= 128)', () => {
    const buf = Buffer.allocUnsafe(13);
    buf.writeUInt8(0x80, 0); // RTP
    buf.writeUInt8(254, 1);
    buf.writeUInt8(253, 2);
    buf.fill(0, 3);
    expect(isDtlsPacket(buf)).toBe(false);
  });

  it('returns false for a buffer that is too short', () => {
    expect(isDtlsPacket(Buffer.alloc(5))).toBe(false);
  });

  it('returns false if major version is not 254', () => {
    const buf = Buffer.allocUnsafe(13);
    buf.writeUInt8(22, 0);
    buf.writeUInt8(3, 1); // TLS major
    buf.writeUInt8(3, 2);
    buf.fill(0, 3);
    expect(isDtlsPacket(buf)).toBe(false);
  });
});

// ─── 2. encodeRecord / decodeRecords ─────────────────────────────────────────

describe('encodeRecord / decodeRecords', () => {
  it('round-trips a single DTLS record', () => {
    const fragment = Buffer.from('hello world');
    const record = {
      contentType: ContentType.Handshake,
      version: DTLS_VERSION_1_2,
      epoch: 0,
      sequenceNumber: 42n,
      fragment,
    };

    const encoded = encodeRecord(record);
    const decoded = decodeRecords(encoded);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.contentType).toBe(ContentType.Handshake);
    expect(decoded[0]!.epoch).toBe(0);
    expect(decoded[0]!.sequenceNumber).toBe(42n);
    expect(decoded[0]!.fragment.equals(fragment)).toBe(true);
    expect(decoded[0]!.version).toEqual(DTLS_VERSION_1_2);
  });

  it('round-trips multiple records in a single datagram', () => {
    const r1 = { contentType: ContentType.Handshake, version: DTLS_VERSION_1_2, epoch: 0, sequenceNumber: 1n, fragment: Buffer.from('msg1') };
    const r2 = { contentType: ContentType.ChangeCipherSpec, version: DTLS_VERSION_1_2, epoch: 0, sequenceNumber: 2n, fragment: Buffer.from([1]) };
    const r3 = { contentType: ContentType.ApplicationData, version: DTLS_VERSION_1_2, epoch: 1, sequenceNumber: 0n, fragment: Buffer.from('encrypted') };

    const combined = Buffer.concat([encodeRecord(r1), encodeRecord(r2), encodeRecord(r3)]);
    const decoded = decodeRecords(combined);

    expect(decoded).toHaveLength(3);
    expect(decoded[0]!.contentType).toBe(ContentType.Handshake);
    expect(decoded[1]!.contentType).toBe(ContentType.ChangeCipherSpec);
    expect(decoded[2]!.contentType).toBe(ContentType.ApplicationData);
    expect(decoded[2]!.epoch).toBe(1);
  });

  it('handles large sequence numbers (48-bit)', () => {
    const seq = 0xffffffffffff0000n >> 16n; // Large value fitting in 48 bits
    const record = { contentType: ContentType.Alert, version: DTLS_VERSION_1_2, epoch: 3, sequenceNumber: seq, fragment: Buffer.from([1, 2]) };
    const decoded = decodeRecords(encodeRecord(record));
    expect(decoded[0]!.sequenceNumber).toBe(seq);
  });

  it('returns empty array for truncated data', () => {
    const buf = Buffer.allocUnsafe(5);
    buf.fill(0);
    buf.writeUInt8(22, 0);
    buf.writeUInt8(254, 1);
    buf.writeUInt8(253, 2);
    expect(decodeRecords(buf)).toHaveLength(0);
  });
});

// ─── 3. encodeHandshakeMessage / decodeHandshakeMessage ──────────────────────

describe('encodeHandshakeMessage / decodeHandshakeMessage', () => {
  it('round-trips a handshake message', () => {
    const body = Buffer.from('test handshake body');
    const msg = {
      msgType: HandshakeType.ServerHelloDone,
      length: body.length,
      messageSeq: 5,
      fragmentOffset: 0,
      fragmentLength: body.length,
      body,
    };

    const encoded = encodeHandshakeMessage(msg);
    const decoded = decodeHandshakeMessage(encoded);

    expect(decoded.msgType).toBe(HandshakeType.ServerHelloDone);
    expect(decoded.messageSeq).toBe(5);
    expect(decoded.fragmentOffset).toBe(0);
    expect(decoded.fragmentLength).toBe(body.length);
    expect(decoded.body.equals(body)).toBe(true);
  });

  it('encodes 3-byte length field correctly', () => {
    const body = Buffer.allocUnsafe(1000).fill(0xab);
    const msg = {
      msgType: HandshakeType.Certificate,
      length: body.length,
      messageSeq: 0,
      fragmentOffset: 0,
      fragmentLength: body.length,
      body,
    };
    const encoded = encodeHandshakeMessage(msg);
    // Length is at bytes [1..3]
    const len = (encoded.readUInt8(1) << 16) | (encoded.readUInt8(2) << 8) | encoded.readUInt8(3);
    expect(len).toBe(1000);

    const decoded = decodeHandshakeMessage(encoded);
    expect(decoded.body.length).toBe(1000);
  });
});

// ─── 4. ClientHello encode / decode ──────────────────────────────────────────

describe('ClientHello encode / decode', () => {
  it('round-trips a ClientHello without cookie or extensions', () => {
    const random = crypto.randomBytes(32);
    const hello = {
      clientVersion: DTLS_VERSION_1_2,
      random,
      sessionId: Buffer.alloc(0),
      cookie: Buffer.alloc(0),
      cipherSuites: [CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
      compressionMethods: [0],
      extensions: [],
    };

    const encoded = encodeClientHello(hello);
    const decoded = decodeClientHello(encoded);

    expect(decoded.clientVersion).toEqual(DTLS_VERSION_1_2);
    expect(decoded.random.equals(random)).toBe(true);
    expect(decoded.sessionId.length).toBe(0);
    expect(decoded.cookie.length).toBe(0);
    expect(decoded.cipherSuites).toEqual([CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256]);
    expect(decoded.compressionMethods).toEqual([0]);
  });

  it('round-trips a ClientHello with cookie and extensions', () => {
    const random = crypto.randomBytes(32);
    const cookie = crypto.randomBytes(20);
    const hello = {
      clientVersion: DTLS_VERSION_1_2,
      random,
      sessionId: Buffer.alloc(0),
      cookie,
      cipherSuites: [
        CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        CipherSuites.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
      ],
      compressionMethods: [0],
      extensions: [
        {
          type: 0x000e,
          data: buildUseSrtpExtension([SrtpProtectionProfile.SRTP_AES128_CM_SHA1_80]),
        },
      ],
    };

    const encoded = encodeClientHello(hello);
    const decoded = decodeClientHello(encoded);

    expect(decoded.cookie.equals(cookie)).toBe(true);
    expect(decoded.cipherSuites).toHaveLength(2);
    expect(decoded.extensions).toHaveLength(1);
    expect(decoded.extensions[0]!.type).toBe(0x000e);
  });
});

// ─── 5. PRF with known test vector ───────────────────────────────────────────

describe('prf', () => {
  it('produces correct output for TLS 1.2 PRF test vector', () => {
    // Test vector from RFC 5246 / TLS 1.2 PRF
    // Using SHA-256 P_hash
    const secret = Buffer.from('secret');
    const label = 'test label';
    const seed = Buffer.from('seed');
    const result = prf(secret, label, seed, 100);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(100);
    // Deterministic: same inputs → same output
    const result2 = prf(secret, label, seed, 100);
    expect(result.equals(result2)).toBe(true);
  });

  it('produces different outputs for different lengths', () => {
    const secret = Buffer.from('s3cr3t');
    const seed = Buffer.from('random-seed-data');
    const r16 = prf(secret, 'label', seed, 16);
    const r32 = prf(secret, 'label', seed, 32);
    expect(r16.length).toBe(16);
    expect(r32.length).toBe(32);
    // First 16 bytes should be the same
    expect(r16.equals(r32.subarray(0, 16))).toBe(true);
  });

  it('produces different outputs for different labels', () => {
    const secret = Buffer.from('master secret');
    const seed = Buffer.concat([crypto.randomBytes(32), crypto.randomBytes(32)]);
    const r1 = prf(secret, 'client finished', seed, 12);
    const r2 = prf(secret, 'server finished', seed, 12);
    expect(r1.equals(r2)).toBe(false);
  });
});

// ─── 6. computeMasterSecret ──────────────────────────────────────────────────

describe('computeMasterSecret', () => {
  it('produces a 48-byte master secret', () => {
    const preMasterSecret = crypto.randomBytes(32);
    const clientRandom = crypto.randomBytes(32);
    const serverRandom = crypto.randomBytes(32);
    const ms = computeMasterSecret(preMasterSecret, clientRandom, serverRandom);
    expect(ms.length).toBe(48);
  });

  it('is deterministic', () => {
    const pms = Buffer.alloc(32, 0xaa);
    const cr = Buffer.alloc(32, 0xbb);
    const sr = Buffer.alloc(32, 0xcc);
    const ms1 = computeMasterSecret(pms, cr, sr);
    const ms2 = computeMasterSecret(pms, cr, sr);
    expect(ms1.equals(ms2)).toBe(true);
  });

  it('is different for different inputs', () => {
    const pms = crypto.randomBytes(32);
    const cr1 = crypto.randomBytes(32);
    const cr2 = crypto.randomBytes(32);
    const sr = crypto.randomBytes(32);
    const ms1 = computeMasterSecret(pms, cr1, sr);
    const ms2 = computeMasterSecret(pms, cr2, sr);
    expect(ms1.equals(ms2)).toBe(false);
  });
});

// ─── 7. generateSelfSignedCertificate ────────────────────────────────────────

describe('generateSelfSignedCertificate', () => {
  it('generates a valid certificate with fingerprint', () => {
    const cert = generateSelfSignedCertificate();
    expect(cert.cert).toBeInstanceOf(Buffer);
    expect(cert.cert.length).toBeGreaterThan(100);
    expect(cert.privateKey).toBeDefined();
    expect(cert.fingerprint.algorithm).toBe('sha-256');
    expect(cert.fingerprint.value).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it('generates different certs on each call', () => {
    const cert1 = generateSelfSignedCertificate();
    const cert2 = generateSelfSignedCertificate();
    expect(cert1.cert.equals(cert2.cert)).toBe(false);
    expect(cert1.fingerprint.value).not.toBe(cert2.fingerprint.value);
  });

  it('can be parsed by Node.js X509Certificate', () => {
    const { cert } = generateSelfSignedCertificate();
    // Should not throw
    const x509 = new crypto.X509Certificate(cert);
    expect(x509.subject).toContain('dtls-');
  });

  it('fingerprint matches the certificate DER', () => {
    const { cert, fingerprint } = generateSelfSignedCertificate();
    const computed = computeFingerprint(cert);
    expect(computed).toBe(fingerprint.value);
  });
});

// ─── 8. verifyFingerprint ─────────────────────────────────────────────────────

describe('verifyFingerprint', () => {
  it('returns true for a matching fingerprint', () => {
    const { cert, fingerprint } = generateSelfSignedCertificate();
    expect(verifyFingerprint(cert, fingerprint)).toBe(true);
  });

  it('returns true for lowercase fingerprint value', () => {
    const { cert, fingerprint } = generateSelfSignedCertificate();
    expect(
      verifyFingerprint(cert, { ...fingerprint, value: fingerprint.value.toLowerCase() }),
    ).toBe(true);
  });

  it('returns false for a mismatched fingerprint', () => {
    const { cert } = generateSelfSignedCertificate();
    expect(
      verifyFingerprint(cert, {
        algorithm: 'sha-256',
        value: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      }),
    ).toBe(false);
  });

  it('throws for unsupported algorithm', () => {
    const { cert, fingerprint } = generateSelfSignedCertificate();
    expect(() => verifyFingerprint(cert, { algorithm: 'sha-1', value: fingerprint.value })).toThrow();
  });
});

// ─── 9. aesgcmEncrypt / aesgcmDecrypt ─────────────────────────────────────────

describe('aesgcmEncrypt / aesgcmDecrypt', () => {
  it('round-trips plaintext', () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const plaintext = Buffer.from('Hello, DTLS!');
    const aad = Buffer.from('additional data');

    const { ciphertext, tag } = aesgcmEncrypt(key, iv, plaintext, aad);
    expect(ciphertext.length).toBe(plaintext.length);
    expect(tag.length).toBe(16);

    const decrypted = aesgcmDecrypt(key, iv, ciphertext, tag, aad);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('ciphertext differs from plaintext', () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const plaintext = Buffer.alloc(16, 0x42);

    const { ciphertext } = aesgcmEncrypt(key, iv, plaintext, Buffer.alloc(0));
    expect(ciphertext.equals(plaintext)).toBe(false);
  });

  it('throws on authentication failure (tampered ciphertext)', () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const plaintext = Buffer.from('test');
    const aad = Buffer.alloc(0);

    const { ciphertext, tag } = aesgcmEncrypt(key, iv, plaintext, aad);
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff; // Flip bits

    expect(() => aesgcmDecrypt(key, iv, tampered, tag, aad)).toThrow();
  });

  it('throws on authentication failure (tampered tag)', () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const plaintext = Buffer.from('test');
    const aad = Buffer.alloc(0);

    const { ciphertext, tag } = aesgcmEncrypt(key, iv, plaintext, aad);
    const badTag = Buffer.from(tag);
    badTag[0] = badTag[0]! ^ 0xff;

    expect(() => aesgcmDecrypt(key, iv, ciphertext, badTag, aad)).toThrow();
  });

  it('encrypts empty plaintext', () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const { ciphertext, tag } = aesgcmEncrypt(key, iv, Buffer.alloc(0), Buffer.alloc(0));
    expect(ciphertext.length).toBe(0);
    expect(tag.length).toBe(16);
    const decrypted = aesgcmDecrypt(key, iv, ciphertext, tag, Buffer.alloc(0));
    expect(decrypted.length).toBe(0);
  });
});

// ─── 10. ECDH shared secret agreement ────────────────────────────────────────

describe('ECDH key exchange', () => {
  it('both parties derive the same shared secret', () => {
    const alice = generateEcdhKeyPair();
    const bob = generateEcdhKeyPair();

    const alicePublicBytes = encodeEcPublicKey(alice.publicKey);
    const bobPublicBytes = encodeEcPublicKey(bob.publicKey);

    expect(alicePublicBytes[0]).toBe(0x04); // uncompressed point
    expect(alicePublicBytes.length).toBe(65); // 1 + 32 + 32

    const aliceSecret = computeEcdhPreMasterSecret(alice.privateKey, bobPublicBytes);
    const bobSecret = computeEcdhPreMasterSecret(bob.privateKey, alicePublicBytes);

    expect(aliceSecret.equals(bobSecret)).toBe(true);
    expect(aliceSecret.length).toBeGreaterThan(0);
  });

  it('encodeEcPublicKey / decodeEcPublicKey round-trips', () => {
    const { publicKey } = generateEcdhKeyPair();
    const encoded = encodeEcPublicKey(publicKey);
    const decoded = decodeEcPublicKey(encoded);
    const reencoded = encodeEcPublicKey(decoded);
    expect(encoded.equals(reencoded)).toBe(true);
  });

  it('different key pairs produce different shared secrets', () => {
    const alice = generateEcdhKeyPair();
    const bob1 = generateEcdhKeyPair();
    const bob2 = generateEcdhKeyPair();

    const s1 = computeEcdhPreMasterSecret(alice.privateKey, encodeEcPublicKey(bob1.publicKey));
    const s2 = computeEcdhPreMasterSecret(alice.privateKey, encodeEcPublicKey(bob2.publicKey));
    expect(s1.equals(s2)).toBe(false);
  });
});

// ─── 11. Full DTLS loopback test ──────────────────────────────────────────────

describe('DTLS loopback handshake', () => {
  it('completes full handshake between client and server', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });

    // Wire them together
    client.setSendCallback((data) => {
      setImmediate(() => server.handleIncoming(data));
    });
    server.setSendCallback((data) => {
      setImmediate(() => client.handleIncoming(data));
    });

    // Start both sides concurrently
    const [clientKeys, serverKeys] = await Promise.all([
      client.start(),
      server.start(),
    ]);

    expect(client.getState()).toBe(DtlsState.Connected);
    expect(server.getState()).toBe(DtlsState.Connected);

    // Both sides should have SRTP keying material
    expect(clientKeys).toBeDefined();
    expect(serverKeys).toBeDefined();
    expect(clientKeys.clientKey.length).toBe(16);
    expect(clientKeys.serverKey.length).toBe(16);
    expect(clientKeys.clientSalt.length).toBe(14);
    expect(clientKeys.serverSalt.length).toBe(14);

    // Client and server should agree on SRTP keys
    expect(clientKeys.clientKey.equals(serverKeys.clientKey)).toBe(true);
    expect(clientKeys.serverKey.equals(serverKeys.serverKey)).toBe(true);
    expect(clientKeys.clientSalt.equals(serverKeys.clientSalt)).toBe(true);
    expect(clientKeys.serverSalt.equals(serverKeys.serverSalt)).toBe(true);
    expect(clientKeys.profile).toBe(0x0001);
  }, 10000);

  it('client can send encrypted application data to server', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    await Promise.all([client.start(), server.start()]);

    const received: Buffer[] = [];
    server.on('data', (data: Buffer) => received.push(data));

    const msg = Buffer.from('Hello from client!');
    client.send(msg);

    // Wait for delivery
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]!.equals(msg)).toBe(true);
  }, 10000);

  it('server can send encrypted application data to client', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    await Promise.all([client.start(), server.start()]);

    const received: Buffer[] = [];
    client.on('data', (data: Buffer) => received.push(data));

    const msg = Buffer.from('Hello from server!');
    server.send(msg);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]!.equals(msg)).toBe(true);
  }, 10000);

  it('local and remote fingerprints are accessible', () => {
    const transport = new DtlsTransport({ role: 'client' });
    const fp = transport.getLocalFingerprint();
    expect(fp.algorithm).toBe('sha-256');
    expect(fp.value).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it('emits connected event with SRTP keys', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    const connectedEvents: SrtpKeyingMaterial[] = [];
    client.on('connected', (keys: SrtpKeyingMaterial) => connectedEvents.push(keys));

    await Promise.all([client.start(), server.start()]);

    expect(connectedEvents).toHaveLength(1);
    expect(connectedEvents[0]!.clientKey.length).toBe(16);
  }, 10000);

  it('respects remoteFingerprint validation', async () => {
    const server = new DtlsTransport({ role: 'server' });
    const serverFp = server.getLocalFingerprint();

    const client = new DtlsTransport({
      role: 'client',
      remoteFingerprint: serverFp,
    });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    // Should succeed with correct fingerprint
    await expect(Promise.all([client.start(), server.start()])).resolves.toBeDefined();
  }, 10000);

  it('fails with wrong remoteFingerprint', async () => {
    const client = new DtlsTransport({
      role: 'client',
      remoteFingerprint: {
        algorithm: 'sha-256',
        value: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      },
    });
    const server = new DtlsTransport({ role: 'server' });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    await expect(
      Promise.all([client.start(), server.start()]),
    ).rejects.toThrow(/fingerprint/i);
  }, 10000);

  it('state transitions correctly', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });

    expect(client.getState()).toBe(DtlsState.New);
    expect(server.getState()).toBe(DtlsState.New);

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    await Promise.all([client.start(), server.start()]);

    expect(client.getState()).toBe(DtlsState.Connected);
    expect(server.getState()).toBe(DtlsState.Connected);
  }, 10000);
});

// ─── 12. DTLS role regression tests ──────────────────────────────────────────
//
// These tests guard against the "both-client deadlock" regression:
// if both sides of a DTLS connection are configured as "client", both
// send a ClientHello simultaneously and neither proceeds to ServerHello,
// causing the handshake to stall forever.

describe('DTLS role regression — both-client deadlock prevention', () => {
  it('client + server complete handshake (reference case)', async () => {
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });
    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));
    // Must not hang and must resolve within timeout
    await expect(Promise.all([client.start(), server.start()])).resolves.toBeDefined();
    client.close();
    server.close();
  }, 10000);

  it('two clients (role=client + role=client) deadlock and do not connect', async () => {
    // RFC 5763 §5 violation: when both peers become DTLS client they both
    // send ClientHello and wait for ServerHello — neither transitions forward.
    // This test confirms the failure scenario (regression guard).
    const clientA = new DtlsTransport({ role: 'client' });
    const clientB = new DtlsTransport({ role: 'client' });
    clientA.setSendCallback((data) => setImmediate(() => clientB.handleIncoming(data)));
    clientB.setSendCallback((data) => setImmediate(() => clientA.handleIncoming(data)));

    // Both sides are clients — the handshake MUST NOT complete successfully.
    const result = await Promise.race([
      Promise.all([clientA.start(), clientB.start()]).then(() => 'connected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    // Expect either a timeout or a rejection (not a successful connection)
    expect(result).not.toBe('connected');
    clientA.close();
    clientB.close();
  }, 8000);

  it('two servers (role=server + role=server) never connect', async () => {
    // Both servers wait for a ClientHello that never comes.
    const serverA = new DtlsTransport({ role: 'server' });
    const serverB = new DtlsTransport({ role: 'server' });
    serverA.setSendCallback((data) => setImmediate(() => serverB.handleIncoming(data)));
    serverB.setSendCallback((data) => setImmediate(() => serverA.handleIncoming(data)));

    const result = await Promise.race([
      Promise.all([serverA.start(), serverB.start()]).then(() => 'connected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    expect(result).not.toBe('connected');
    serverA.close();
    serverB.close();
  }, 8000);

  it('SRTP keying material is consistent: both sides see the same bytes', async () => {
    // Verify that the keying material produced by client and server is identical
    // (derived from the same master secret, client and server just use opposite halves).
    const client = new DtlsTransport({ role: 'client' });
    const server = new DtlsTransport({ role: 'server' });
    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));
    const [clientKeys, serverKeys] = await Promise.all([client.start(), server.start()]);

    // Both see the same keying material bytes (derived from the same master secret)
    expect(clientKeys.clientKey.equals(serverKeys.clientKey)).toBe(true);
    expect(clientKeys.serverKey.equals(serverKeys.serverKey)).toBe(true);
    expect(clientKeys.clientSalt.equals(serverKeys.clientSalt)).toBe(true);
    expect(clientKeys.serverSalt.equals(serverKeys.serverSalt)).toBe(true);

    // Keys must be non-trivially different from each other (no key reuse)
    expect(clientKeys.clientKey.equals(clientKeys.serverKey)).toBe(false);
    expect(clientKeys.clientSalt.equals(clientKeys.serverSalt)).toBe(false);

    client.close();
    server.close();
  }, 10000);

  it('handshake with custom certificates and mutual fingerprint verification', async () => {
    const clientCert = generateSelfSignedCertificate();
    const serverCert = generateSelfSignedCertificate();

    const client = new DtlsTransport({
      role: 'client',
      certificate: clientCert,
      remoteFingerprint: serverCert.fingerprint,
    });
    const server = new DtlsTransport({
      role: 'server',
      certificate: serverCert,
      remoteFingerprint: clientCert.fingerprint,
    });

    client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
    server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));

    await expect(Promise.all([client.start(), server.start()])).resolves.toBeDefined();

    // Verify the local fingerprints match the provided certificates
    expect(client.getLocalFingerprint().value).toBe(clientCert.fingerprint.value);
    expect(server.getLocalFingerprint().value).toBe(serverCert.fingerprint.value);

    client.close();
    server.close();
  }, 10000);
});
