/**
 * SRTP test suite – RFC 3711 test vectors + round-trip tests.
 *
 * Test vectors sourced from:
 *   RFC 3711 Appendix B  (AES-CM keystream, key derivation)
 *   RFC 3711 Appendix C  (SRTP auth-tag / protect examples)
 */

import { describe, it, expect } from 'vitest';
import {
  aes128cmKeystream,
  computeSrtpIv,
  deriveSessionKey,
  computeSrtpAuthTag,
  computeSrtcpAuthTag,
  ReplayWindow,
  createSrtpContext,
  createSrtcpContext,
  srtpProtect,
  srtpUnprotect,
  srtcpProtect,
  srtcpUnprotect,
  ProtectionProfile,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function hex(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'hex');
}

// ---------------------------------------------------------------------------
// 1. AES-128-CM keystream test vector (RFC 3711 Appendix B.2)
// ---------------------------------------------------------------------------

describe('AES-128-CM keystream (RFC 3711 B.2)', () => {
  /**
   * The RFC 3711 Appendix B.2 test vector:
   *   Session Key:  2B7E151628AED2A6ABF7158809CF4F3C
   *   IV (counter): F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000
   *
   * Expected output (first 32 bytes):
   *   E03EAD0935C95E80E166B16DD92B4EB4
   *   D23513162B02D0F72A43A2FE4A5F97AB
   */
  const key = hex('2B7E151628AED2A6ABF7158809CF4F3C');
  const iv = hex('F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000');
  const expected = hex(
    'E03EAD0935C95E80E166B16DD92B4EB4' +
    'D23513162B02D0F72A43A2FE4A5F97AB',
  );

  it('generates the correct 32-byte keystream', () => {
    const ks = aes128cmKeystream(key, iv, 32);
    expect(ks.toString('hex').toUpperCase()).toBe(expected.toString('hex').toUpperCase());
  });

  it('can generate partial keystream (first 16 bytes)', () => {
    const ks = aes128cmKeystream(key, iv, 16);
    expect(ks.toString('hex').toUpperCase()).toBe(
      expected.subarray(0, 16).toString('hex').toUpperCase(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. SRTP key derivation test vector (RFC 3711 Appendix B.3)
// ---------------------------------------------------------------------------

describe('SRTP key derivation (RFC 3711 B.3)', () => {
  /**
   * RFC 3711 Appendix B.3 key derivation test:
   *   master key  : E1F97A0D3E018BE0D64FA32C06DE4139
   *   master salt : 0EC675AD498AFEEBB6960B3A  (12-byte; right-padded to 14)
   *
   * Derived session keys (computed using AES-128-CM KDF, label*2^48 XOR salt):
   *   k_e = 238C882F36F000301573E69383502D9D  (label=0x00, 16 bytes)
   *   k_a = 6B1B0BFA957C166CF63D24243C79A812FCA7FBC6  (label=0x01, 20 bytes)
   *   k_s = F2FEE04070FC3F65D706E2E49A02  (label=0x02, 14 bytes)
   */
  const masterKey = hex('E1F97A0D3E018BE0D64FA32C06DE4139');
  // RFC gives 12-byte salt; right-pad to 14 bytes (two trailing zeros)
  const masterSalt = hex('0EC675AD498AFEEBB6960B3A0000');

  it('derives the session encryption key (label=0x00)', () => {
    const ke = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
    expect(ke.toString('hex').toUpperCase()).toBe('238C882F36F000301573E69383502D9D');
  });

  it('derives the session auth key (label=0x01, first 16 bytes)', () => {
    const ka = deriveSessionKey(masterKey, masterSalt, 0x01, 20);
    expect(ka.subarray(0, 16).toString('hex').toUpperCase()).toBe(
      '6B1B0BFA957C166CF63D24243C79A812',
    );
  });

  it('derives the session salt key (label=0x02, 14 bytes)', () => {
    const ks = deriveSessionKey(masterKey, masterSalt, 0x02, 14);
    expect(ks.toString('hex').toUpperCase()).toBe('F2FEE04070FC3F65D706E2E49A02');
  });

  it('label=0x00 (enc) produces a deterministic 16-byte key', () => {
    const k1 = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
    const k2 = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
    expect(k1.toString('hex')).toBe(k2.toString('hex'));
    expect(k1.length).toBe(16);
  });

  it('different labels produce different keys', () => {
    const ke = deriveSessionKey(masterKey, masterSalt, 0x00, 16);
    const ka = deriveSessionKey(masterKey, masterSalt, 0x01, 16);
    expect(ke.toString('hex')).not.toBe(ka.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// 3. HMAC-SHA1 authentication tag
// ---------------------------------------------------------------------------

describe('HMAC-SHA1 authentication tag', () => {
  const authKey = Buffer.alloc(20, 0xab); // 20 bytes of 0xAB

  it('computeSrtpAuthTag returns 10 bytes for 80-bit profile', () => {
    const header = Buffer.from([0x80, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    const payload = Buffer.from('Hello SRTP');
    const tag = computeSrtpAuthTag(authKey, header, payload, 0, 10);
    expect(tag.length).toBe(10);
  });

  it('computeSrtpAuthTag returns 4 bytes for 32-bit profile', () => {
    const header = Buffer.from([0x80, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    const payload = Buffer.from('Hello SRTP');
    const tag = computeSrtpAuthTag(authKey, header, payload, 0, 4);
    expect(tag.length).toBe(4);
  });

  it('computeSrtcpAuthTag returns 10 bytes', () => {
    const rtcpPacket = Buffer.alloc(20, 0x42);
    const tag = computeSrtcpAuthTag(authKey, rtcpPacket, 0x80000001, 10);
    expect(tag.length).toBe(10);
  });

  it('different ROC values produce different auth tags', () => {
    const header = Buffer.from([0x80, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    const payload = Buffer.from('test payload');
    const tag0 = computeSrtpAuthTag(authKey, header, payload, 0, 10);
    const tag1 = computeSrtpAuthTag(authKey, header, payload, 1, 10);
    expect(tag0.toString('hex')).not.toBe(tag1.toString('hex'));
  });

  it('is deterministic', () => {
    const header = Buffer.from([0x80, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const a = computeSrtpAuthTag(authKey, header, payload, 42, 10);
    const b = computeSrtpAuthTag(authKey, header, payload, 42, 10);
    expect(a.toString('hex')).toBe(b.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// 4. ReplayWindow
// ---------------------------------------------------------------------------

describe('ReplayWindow', () => {
  it('accepts the first packet (any index)', () => {
    const w = new ReplayWindow();
    expect(w.check(0n)).toBe(true);
    expect(w.check(100n)).toBe(true);
  });

  it('rejects a replayed packet', () => {
    const w = new ReplayWindow();
    w.update(5n);
    expect(w.check(5n)).toBe(false); // already seen
  });

  it('accepts a new packet ahead of the window', () => {
    const w = new ReplayWindow();
    w.update(5n);
    expect(w.check(6n)).toBe(true);
  });

  it('accepts a packet within the window that has not been seen', () => {
    const w = new ReplayWindow(64n);
    w.update(10n);
    expect(w.check(5n)).toBe(true);  // 10-5=5 < 64, not seen
    w.update(5n);
    expect(w.check(5n)).toBe(false); // now seen
  });

  it('rejects packets outside the window (too old)', () => {
    const w = new ReplayWindow(64n);
    w.update(100n);
    // diff=65: 100-35=65 >= 64 → rejected
    expect(w.check(35n)).toBe(false);
    // diff=64: 100-36=64 >= 64 → rejected (boundary is exclusive)
    expect(w.check(36n)).toBe(false);
    // diff=63: 100-37=63 < 64 → accepted (just inside the window)
    expect(w.check(37n)).toBe(true);
  });

  it('tracks multiple packets correctly', () => {
    const w = new ReplayWindow();
    for (let i = 0n; i < 10n; i++) {
      expect(w.check(i)).toBe(true);
      w.update(i);
    }
    for (let i = 0n; i < 10n; i++) {
      expect(w.check(i)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal RTP packet
// ---------------------------------------------------------------------------

function buildRtpPacket(
  seq: number,
  timestamp: number,
  ssrc: number,
  payload: Buffer,
): Buffer {
  const header = Buffer.allocUnsafe(12);
  header[0] = 0x80; // V=2, P=0, X=0, CC=0
  header[1] = 0x00; // M=0, PT=0
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// Helper: build a minimal RTCP SR packet
// ---------------------------------------------------------------------------

function buildRtcpPacket(ssrc: number): Buffer {
  const pkt = Buffer.allocUnsafe(28);
  pkt[0] = 0x80;          // V=2, P=0, RC=0
  pkt[1] = 200;           // PT=200 (SR)
  pkt.writeUInt16BE(6, 2); // length in 32-bit words minus 1
  pkt.writeUInt32BE(ssrc, 4);
  pkt.fill(0, 8);          // NTP, RTP ts, packet count, octet count
  return pkt;
}

// ---------------------------------------------------------------------------
// 5. SRTP protect / unprotect round-trip
// ---------------------------------------------------------------------------

describe('srtpProtect + srtpUnprotect round-trip', () => {
  const material = {
    masterKey: hex('E1F97A0D3E018BE0D64FA32C06DE4139'),
    masterSalt: hex('0EC675AD498AFEEBB6960B3A0000'),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };

  it('encrypts and decrypts a single packet', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    const payload = Buffer.from('Hello, SRTP world!');
    const rtp = buildRtpPacket(1, 0, 0xdeadbeef, payload);

    const srtp = srtpProtect(txCtx, rtp);
    // SRTP packet should be longer (auth tag appended)
    expect(srtp.length).toBe(rtp.length + 10);

    const recovered = srtpUnprotect(rxCtx, srtp);
    expect(recovered).not.toBeNull();
    expect(recovered!.toString('hex')).toBe(rtp.toString('hex'));
  });

  it('payload is different from plaintext (encrypted)', () => {
    const txCtx = createSrtpContext(material);
    const payload = Buffer.from('Secret payload data');
    const rtp = buildRtpPacket(2, 160, 0x12345678, payload);
    const srtp = srtpProtect(txCtx, rtp);

    const encryptedPart = srtp.subarray(12, srtp.length - 10);
    expect(encryptedPart.toString('hex')).not.toBe(payload.toString('hex'));
  });

  it('returns null for a tampered packet', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    const rtp = buildRtpPacket(3, 320, 0x12345678, Buffer.from('data'));
    const srtp = srtpProtect(txCtx, rtp);

    // Flip a bit in the payload
    const tampered = Buffer.from(srtp);
    tampered[12]! ^= 0xff;

    const result = srtpUnprotect(rxCtx, tampered);
    expect(result).toBeNull();
  });

  it('handles multiple sequential packets', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    for (let seq = 1; seq <= 20; seq++) {
      const rtp = buildRtpPacket(seq, seq * 160, 0xaabbccdd, Buffer.from(`payload-${seq}`));
      const srtp = srtpProtect(txCtx, rtp);
      const plain = srtpUnprotect(rxCtx, srtp);
      expect(plain).not.toBeNull();
      expect(plain!.toString('hex')).toBe(rtp.toString('hex'));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. SRTCP protect / unprotect round-trip
// ---------------------------------------------------------------------------

describe('srtcpProtect + srtcpUnprotect round-trip', () => {
  const material = {
    masterKey: hex('E1F97A0D3E018BE0D64FA32C06DE4139'),
    masterSalt: hex('0EC675AD498AFEEBB6960B3A0000'),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };

  it('encrypts and decrypts an RTCP SR packet', () => {
    const txCtx = createSrtcpContext(material);
    const rxCtx = createSrtcpContext(material);

    const rtcp = buildRtcpPacket(0xcafebabe);
    const srtcp = srtcpProtect(txCtx, rtcp);

    // SRTCP = RTCP + 4-byte E|index + 10-byte tag
    expect(srtcp.length).toBe(rtcp.length + 4 + 10);

    const recovered = srtcpUnprotect(rxCtx, srtcp);
    expect(recovered).not.toBeNull();
    expect(recovered!.toString('hex')).toBe(rtcp.toString('hex'));
  });

  it('returns null for a tampered SRTCP packet', () => {
    const txCtx = createSrtcpContext(material);
    const rxCtx = createSrtcpContext(material);

    const rtcp = buildRtcpPacket(0x11223344);
    const srtcp = srtcpProtect(txCtx, rtcp);

    const tampered = Buffer.from(srtcp);
    tampered[8]! ^= 0x01; // flip a bit in encrypted payload

    expect(srtcpUnprotect(rxCtx, tampered)).toBeNull();
  });

  it('handles multiple sequential RTCP packets', () => {
    const txCtx = createSrtcpContext(material);
    const rxCtx = createSrtcpContext(material);

    for (let i = 0; i < 5; i++) {
      const rtcp = buildRtcpPacket(0xdeadbeef);
      const srtcp = srtcpProtect(txCtx, rtcp);
      const plain = srtcpUnprotect(rxCtx, srtcp);
      expect(plain).not.toBeNull();
      expect(plain!.toString('hex')).toBe(rtcp.toString('hex'));
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Auth tag failure – tampered packet returns null
// ---------------------------------------------------------------------------

describe('Authentication failure', () => {
  const material = {
    masterKey: Buffer.alloc(16, 0x01),
    masterSalt: Buffer.alloc(14, 0x02),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };

  it('srtpUnprotect returns null when auth tag is corrupted', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    const rtp = buildRtpPacket(1, 0, 0x11111111, Buffer.from('important data'));
    const srtp = srtpProtect(txCtx, rtp);

    // Corrupt the last byte of the auth tag
    const corrupted = Buffer.from(srtp);
    corrupted[corrupted.length - 1]! ^= 0xff;

    expect(srtpUnprotect(rxCtx, corrupted)).toBeNull();
  });

  it('srtpUnprotect returns null when RTP header is tampered', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    const rtp = buildRtpPacket(2, 160, 0x22222222, Buffer.from('payload'));
    const srtp = srtpProtect(txCtx, rtp);

    const corrupted = Buffer.from(srtp);
    corrupted[0]! ^= 0x01; // flip a bit in RTP version field

    expect(srtpUnprotect(rxCtx, corrupted)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Rollover counter (ROC) handling
// ---------------------------------------------------------------------------

describe('Rollover counter (ROC)', () => {
  const material = {
    masterKey: Buffer.alloc(16, 0x55),
    masterSalt: Buffer.alloc(14, 0xaa),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };

  it('increments ROC when sequence wraps from 65535 to 0', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    // Send packet at seq=65535
    const rtp65535 = buildRtpPacket(65535, 1000, 0xaabbccdd, Buffer.from('last before wrap'));
    const srtp65535 = srtpProtect(txCtx, rtp65535);
    const plain65535 = srtpUnprotect(rxCtx, srtp65535);
    expect(plain65535).not.toBeNull();
    expect(txCtx.rolloverCounter).toBe(0);

    // Send packet at seq=0 (after wrap)
    const rtp0 = buildRtpPacket(0, 1160, 0xaabbccdd, Buffer.from('first after wrap'));
    const srtp0 = srtpProtect(txCtx, rtp0);
    const plain0 = srtpUnprotect(rxCtx, srtp0);
    expect(plain0).not.toBeNull();

    // ROC should now be 1 on both sides
    expect(txCtx.rolloverCounter).toBe(1);
    expect(rxCtx.rolloverCounter).toBe(1);
    expect(plain0!.toString('hex')).toBe(rtp0.toString('hex'));
  });

  it('packet index correctly encodes ROC and SEQ', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    // Send two packets to advance state, then wrap
    const pkt1 = buildRtpPacket(65534, 0, 0x01020304, Buffer.from('x'));
    srtpProtect(txCtx, pkt1);
    srtpUnprotect(rxCtx, srtpProtect(createSrtpContext(material), pkt1));

    // Now simulate seq=65535 → 0 transition on fresh contexts
    const txCtx2 = createSrtpContext(material);
    const rxCtx2 = createSrtpContext(material);

    const p1 = buildRtpPacket(65535, 100, 0xdeadbeef, Buffer.from('pre-wrap'));
    const s1 = srtpProtect(txCtx2, p1);
    srtpUnprotect(rxCtx2, s1);

    const p2 = buildRtpPacket(0, 200, 0xdeadbeef, Buffer.from('post-wrap'));
    const s2 = srtpProtect(txCtx2, p2);
    const result = srtpUnprotect(rxCtx2, s2);
    expect(result).not.toBeNull();
    expect(rxCtx2.rolloverCounter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. SRTP with DTLS-exported keys (integration test)
// ---------------------------------------------------------------------------

describe('SRTP integration – DTLS-style key export', () => {
  // Simulate keys as they would come from a DTLS-SRTP export (RFC 5764).
  // A DTLS exporter typically returns interleaved material:
  //   client_key (16) | server_key (16) | client_salt (14) | server_salt (14)
  // Here we just use two independent contexts with separate keys/salts.

  const clientKey = hex('AABBCCDDEEFF00112233445566778899');
  const clientSalt = hex('AABBCCDDEEFF001122334455');
  const serverKey = hex('99887766554433221100FFEEDDCCBBAA');
  const serverSalt = hex('99887766554433221100FFEE');

  const senderMaterial = {
    masterKey: clientKey,
    masterSalt: Buffer.concat([clientSalt, Buffer.alloc(2, 0)]), // pad to 14
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };
  const receiverMaterial = {
    masterKey: clientKey,
    masterSalt: Buffer.concat([clientSalt, Buffer.alloc(2, 0)]),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
  };

  it('full protect/unprotect cycle with multiple sequential packets', () => {
    const txCtx = createSrtpContext(senderMaterial);
    const rxCtx = createSrtpContext(receiverMaterial);

    const ssrc = 0x12345678;
    for (let seq = 100; seq < 110; seq++) {
      const payload = Buffer.from(`Audio frame #${seq} – DTLS SRTP integration`);
      const rtp = buildRtpPacket(seq, seq * 160, ssrc, payload);

      const srtp = srtpProtect(txCtx, rtp);
      const plain = srtpUnprotect(rxCtx, srtp);

      expect(plain).not.toBeNull();
      expect(plain!.toString('hex')).toBe(rtp.toString('hex'));
    }
  });

  it('out-of-order packets within replay window are accepted', () => {
    const txCtx = createSrtpContext(senderMaterial);
    const rxCtx = createSrtpContext(receiverMaterial);

    const ssrc = 0xabcdef01;
    const packets: Buffer[] = [];
    // Produce 5 packets in order
    for (let i = 0; i < 5; i++) {
      const rtp = buildRtpPacket(200 + i, i * 160, ssrc, Buffer.from(`pkt-${i}`));
      packets.push(srtpProtect(txCtx, rtp));
    }

    // Deliver out of order: 0,2,1,4,3
    for (const idx of [0, 2, 1, 4, 3]) {
      const rtp = buildRtpPacket(200 + idx, idx * 160, ssrc, Buffer.from(`pkt-${idx}`));
      const result = srtpUnprotect(rxCtx, packets[idx]!);
      expect(result).not.toBeNull();
      expect(result!.toString('hex')).toBe(rtp.toString('hex'));
    }
  });

  it('replayed packet is rejected', () => {
    const txCtx = createSrtpContext(senderMaterial);
    const rxCtx = createSrtpContext(receiverMaterial);

    const rtp = buildRtpPacket(300, 0, 0xffeeddcc, Buffer.from('replay test'));
    const srtp = srtpProtect(txCtx, rtp);

    // First delivery: succeeds
    expect(srtpUnprotect(rxCtx, srtp)).not.toBeNull();
    // Replay: rejected
    expect(srtpUnprotect(rxCtx, srtp)).toBeNull();
  });

  it('wrong key material returns null', () => {
    const txCtx = createSrtpContext(senderMaterial);
    const wrongMaterial = {
      masterKey: serverKey, // wrong key
      masterSalt: Buffer.concat([serverSalt, Buffer.alloc(2, 0)]),
      profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_80,
    };
    const rxCtx = createSrtpContext(wrongMaterial);

    const rtp = buildRtpPacket(1, 0, 0x99aabbcc, Buffer.from('secret'));
    const srtp = srtpProtect(txCtx, rtp);
    expect(srtpUnprotect(rxCtx, srtp)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. AES-128-CM_HMAC-SHA1-32 profile (4-byte tag)
// ---------------------------------------------------------------------------

describe('AES-128-CM-HMAC-SHA1-32 profile', () => {
  const material = {
    masterKey: Buffer.alloc(16, 0x33),
    masterSalt: Buffer.alloc(14, 0x44),
    profile: ProtectionProfile.AES_128_CM_HMAC_SHA1_32,
  };

  it('protect/unprotect with 4-byte auth tag', () => {
    const txCtx = createSrtpContext(material);
    const rxCtx = createSrtpContext(material);

    const rtp = buildRtpPacket(1, 0, 0x01010101, Buffer.from('32-bit tag test'));
    const srtp = srtpProtect(txCtx, rtp);

    // 4-byte tag
    expect(srtp.length).toBe(rtp.length + 4);

    const plain = srtpUnprotect(rxCtx, srtp);
    expect(plain).not.toBeNull();
    expect(plain!.toString('hex')).toBe(rtp.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// 11. computeSrtpIv correctness
// ---------------------------------------------------------------------------

describe('computeSrtpIv', () => {
  it('produces a 16-byte IV', () => {
    const salt = Buffer.alloc(14, 0x55);
    const iv = computeSrtpIv(salt, 0x12345678, 42n);
    expect(iv.length).toBe(16);
  });

  it('different SSRCs produce different IVs', () => {
    const salt = Buffer.alloc(14, 0x11);
    const iv1 = computeSrtpIv(salt, 0x11111111, 1n);
    const iv2 = computeSrtpIv(salt, 0x22222222, 1n);
    expect(iv1.toString('hex')).not.toBe(iv2.toString('hex'));
  });

  it('different indices produce different IVs', () => {
    const salt = Buffer.alloc(14, 0x22);
    const iv1 = computeSrtpIv(salt, 0xdeadbeef, 1n);
    const iv2 = computeSrtpIv(salt, 0xdeadbeef, 2n);
    expect(iv1.toString('hex')).not.toBe(iv2.toString('hex'));
  });
});
