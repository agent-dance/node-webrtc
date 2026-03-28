import { describe, it, expect } from 'vitest';
import {
  encodeRtp,
  decodeRtp,
  isRtpPacket,
  encodeRtcp,
  decodeRtcp,
  isRtcpPacket,
  encodeSr,
  decodeSr,
  encodeRr,
  decodeRr,
  encodeSdes,
  decodeSdes,
  encodeBye,
  decodeBye,
  encodeNack,
  decodeNack,
  encodePli,
  decodePli,
  encodeFir,
  decodeFir,
  encodeRemb,
  decodeRemb,
  seqDiff,
  seqLt,
  seqLte,
  seqGt,
  ntpToUnix,
  unixToNtp,
  ONE_BYTE_PROFILE,
  TWO_BYTE_PROFILE,
  RtcpPacketType,
} from '../src/index.js';
import type {
  RtpPacket,
  RtcpSenderReport,
  RtcpReceiverReport,
  RtcpSdes,
  RtcpBye,
  RtcpNack,
  RtcpPli,
  RtcpFir,
  RtcpRemb,
  ReportBlock,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helper: minimal RTP packet for tests
// ---------------------------------------------------------------------------
function makeRtpPacket(overrides: Partial<RtpPacket> = {}): RtpPacket {
  return {
    version: 2,
    padding: false,
    extension: false,
    csrcCount: 0,
    marker: false,
    payloadType: 96,
    sequenceNumber: 1000,
    timestamp: 90000,
    ssrc: 0xdeadbeef,
    csrcs: [],
    payload: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Encode RTP packet and verify header bytes
// ---------------------------------------------------------------------------
describe('RTP encode', () => {
  it('encodes header bytes correctly', () => {
    const pkt = makeRtpPacket({ marker: true, payloadType: 111, sequenceNumber: 0x1234, timestamp: 0xaabbccdd, ssrc: 0x11223344 });
    const buf = encodeRtp(pkt);

    // Byte 0: V=2, P=0, X=0, CC=0  → 0b10000000 = 0x80
    expect(buf[0]).toBe(0x80);
    // Byte 1: M=1, PT=111 → 0b11101111 = 0xef
    expect(buf[1]).toBe(0b11101111);
    // Sequence number
    expect(buf.readUInt16BE(2)).toBe(0x1234);
    // Timestamp
    expect(buf.readUInt32BE(4)).toBe(0xaabbccdd);
    // SSRC
    expect(buf.readUInt32BE(8)).toBe(0x11223344);
    // Payload
    expect(buf.subarray(12)).toEqual(pkt.payload);
  });

  it('sets extension bit when headerExtension is present', () => {
    const pkt = makeRtpPacket({
      extension: true,
      headerExtension: {
        id: ONE_BYTE_PROFILE,
        values: [{ id: 1, data: Buffer.from([0xab]) }],
      },
    });
    const buf = encodeRtp(pkt);
    // X bit (0x10) should be set in byte 0
    expect(buf[0]! & 0x10).toBe(0x10);
  });
});

// ---------------------------------------------------------------------------
// 2. Decode RTP packet from raw bytes
// ---------------------------------------------------------------------------
describe('RTP decode', () => {
  it('decodes a minimal RTP packet from raw bytes', () => {
    // Manually craft a 12-byte RTP header + 4-byte payload
    const raw = Buffer.alloc(16);
    raw[0] = 0x80; // V=2, P=0, X=0, CC=0
    raw[1] = 0x60; // M=0, PT=96
    raw.writeUInt16BE(42, 2); // seq
    raw.writeUInt32BE(12345, 4); // timestamp
    raw.writeUInt32BE(0xcafebabe, 8); // ssrc
    raw.fill(0xff, 12); // payload

    const pkt = decodeRtp(raw);
    expect(pkt.version).toBe(2);
    expect(pkt.padding).toBe(false);
    expect(pkt.extension).toBe(false);
    expect(pkt.csrcCount).toBe(0);
    expect(pkt.marker).toBe(false);
    expect(pkt.payloadType).toBe(96);
    expect(pkt.sequenceNumber).toBe(42);
    expect(pkt.timestamp).toBe(12345);
    expect(pkt.ssrc).toBe(0xcafebabe);
    expect(pkt.payload).toEqual(Buffer.alloc(4, 0xff));
  });

  it('throws on buffer too short', () => {
    expect(() => decodeRtp(Buffer.alloc(8))).toThrow(RangeError);
  });

  it('throws on invalid version', () => {
    const raw = Buffer.alloc(12);
    raw[0] = 0x00; // V=0
    expect(() => decodeRtp(raw)).toThrow('Invalid RTP version');
  });
});

// ---------------------------------------------------------------------------
// 3. RTP round-trip
// ---------------------------------------------------------------------------
describe('RTP round-trip', () => {
  it('encode then decode matches original', () => {
    const pkt = makeRtpPacket({ marker: true, payloadType: 97, sequenceNumber: 65000, timestamp: 999999, ssrc: 0x12345678 });
    const decoded = decodeRtp(encodeRtp(pkt));

    expect(decoded.version).toBe(pkt.version);
    expect(decoded.padding).toBe(pkt.padding);
    expect(decoded.marker).toBe(pkt.marker);
    expect(decoded.payloadType).toBe(pkt.payloadType);
    expect(decoded.sequenceNumber).toBe(pkt.sequenceNumber);
    expect(decoded.timestamp).toBe(pkt.timestamp);
    expect(decoded.ssrc).toBe(pkt.ssrc);
    expect(decoded.csrcs).toEqual(pkt.csrcs);
    expect(decoded.payload).toEqual(pkt.payload);
  });
});

// ---------------------------------------------------------------------------
// 4. RTP with CSRC
// ---------------------------------------------------------------------------
describe('RTP with CSRC', () => {
  it('encodes and decodes CSRC list', () => {
    const csrcs = [0x11111111, 0x22222222, 0x33333333];
    const pkt = makeRtpPacket({ csrcs, csrcCount: csrcs.length });
    const buf = encodeRtp(pkt);

    // CC field in byte 0
    expect(buf[0]! & 0x0f).toBe(3);

    const decoded = decodeRtp(buf);
    expect(decoded.csrcCount).toBe(3);
    expect(decoded.csrcs).toEqual(csrcs);
    expect(decoded.payload).toEqual(pkt.payload);
  });
});

// ---------------------------------------------------------------------------
// 5. RTP with one-byte header extension
// ---------------------------------------------------------------------------
describe('RTP one-byte header extension', () => {
  it('round-trips one-byte extension values', () => {
    const pkt = makeRtpPacket({
      extension: true,
      headerExtension: {
        id: ONE_BYTE_PROFILE,
        values: [
          { id: 1, data: Buffer.from([0xaa]) },
          { id: 2, data: Buffer.from([0x01, 0x02]) },
        ],
      },
    });
    const decoded = decodeRtp(encodeRtp(pkt));

    expect(decoded.headerExtension).toBeDefined();
    expect(decoded.headerExtension!.id).toBe(ONE_BYTE_PROFILE);
    expect(decoded.headerExtension!.values).toHaveLength(2);
    expect(decoded.headerExtension!.values[0]).toEqual({ id: 1, data: Buffer.from([0xaa]) });
    expect(decoded.headerExtension!.values[1]).toEqual({ id: 2, data: Buffer.from([0x01, 0x02]) });
  });
});

// ---------------------------------------------------------------------------
// 6. RTP with two-byte header extension
// ---------------------------------------------------------------------------
describe('RTP two-byte header extension', () => {
  it('round-trips two-byte extension values', () => {
    const pkt = makeRtpPacket({
      extension: true,
      headerExtension: {
        id: TWO_BYTE_PROFILE,
        values: [
          { id: 100, data: Buffer.from([0x11, 0x22, 0x33]) },
          { id: 200, data: Buffer.from([0xde, 0xad]) },
        ],
      },
    });
    const decoded = decodeRtp(encodeRtp(pkt));

    expect(decoded.headerExtension).toBeDefined();
    expect(decoded.headerExtension!.id).toBe(TWO_BYTE_PROFILE);
    expect(decoded.headerExtension!.values).toHaveLength(2);
    expect(decoded.headerExtension!.values[0]).toEqual({ id: 100, data: Buffer.from([0x11, 0x22, 0x33]) });
    expect(decoded.headerExtension!.values[1]).toEqual({ id: 200, data: Buffer.from([0xde, 0xad]) });
  });
});

// ---------------------------------------------------------------------------
// 7. isRtpPacket detection
// ---------------------------------------------------------------------------
describe('isRtpPacket', () => {
  it('returns true for a valid RTP packet buffer', () => {
    const buf = encodeRtp(makeRtpPacket());
    expect(isRtpPacket(buf)).toBe(true);
  });

  it('returns false for buffers shorter than 12 bytes', () => {
    expect(isRtpPacket(Buffer.alloc(8))).toBe(false);
  });

  it('returns false when version != 2', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x00; // V=0
    buf[1] = 96;
    expect(isRtpPacket(buf)).toBe(false);
  });

  it('returns false for RTCP PT range (200-204)', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x80; // V=2
    buf[1] = 200;
    expect(isRtpPacket(buf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Encode/decode Sender Report (RTCP SR)
// ---------------------------------------------------------------------------
describe('RTCP SR', () => {
  const sr: RtcpSenderReport = {
    ssrc: 0xdeadbeef,
    ntpTimestamp: 0xaabb_ccdd_1122_3344n,
    rtpTimestamp: 0x12345678,
    packetCount: 1000,
    octetCount: 256000,
    reportBlocks: [],
  };

  it('encodes and decodes SR correctly', () => {
    const buf = encodeSr(sr);
    expect(buf[1]).toBe(200); // PT = 200
    const decoded = decodeSr(buf);

    expect(decoded.ssrc).toBe(sr.ssrc);
    expect(decoded.ntpTimestamp).toBe(sr.ntpTimestamp);
    expect(decoded.rtpTimestamp).toBe(sr.rtpTimestamp);
    expect(decoded.packetCount).toBe(sr.packetCount);
    expect(decoded.octetCount).toBe(sr.octetCount);
    expect(decoded.reportBlocks).toHaveLength(0);
  });

  it('SR round-trip via compound encodeRtcp/decodeRtcp', () => {
    const pkts = decodeRtcp(encodeRtcp([{ type: 'sr', packet: sr }]));
    expect(pkts).toHaveLength(1);
    expect(pkts[0]!.type).toBe('sr');
    if (pkts[0]!.type === 'sr') {
      expect(pkts[0]!.packet.ssrc).toBe(sr.ssrc);
      expect(pkts[0]!.packet.ntpTimestamp).toBe(sr.ntpTimestamp);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Encode/decode Receiver Report (RTCP RR) with report blocks
// ---------------------------------------------------------------------------
describe('RTCP RR with report blocks', () => {
  const rb: ReportBlock = {
    ssrc: 0xcafecafe,
    fractionLost: 25,
    cumulativeLost: 100,
    extendedHighestSeq: 0xaabb1234,
    jitter: 512,
    lastSR: 0x01020304,
    delaySinceLastSR: 9000,
  };
  const rr: RtcpReceiverReport = {
    ssrc: 0x11223344,
    reportBlocks: [rb],
  };

  it('encodes and decodes RR with report blocks', () => {
    const buf = encodeRr(rr);
    expect(buf[1]).toBe(201); // PT = 201
    const decoded = decodeRr(buf);

    expect(decoded.ssrc).toBe(rr.ssrc);
    expect(decoded.reportBlocks).toHaveLength(1);
    const drb = decoded.reportBlocks[0]!;
    expect(drb.ssrc).toBe(rb.ssrc);
    expect(drb.fractionLost).toBe(rb.fractionLost);
    expect(drb.cumulativeLost).toBe(rb.cumulativeLost);
    expect(drb.extendedHighestSeq).toBe(rb.extendedHighestSeq);
    expect(drb.jitter).toBe(rb.jitter);
    expect(drb.lastSR).toBe(rb.lastSR);
    expect(drb.delaySinceLastSR).toBe(rb.delaySinceLastSR);
  });
});

// ---------------------------------------------------------------------------
// 10. Encode/decode SDES with CNAME
// ---------------------------------------------------------------------------
describe('RTCP SDES', () => {
  const sdes: RtcpSdes = {
    chunks: [
      {
        ssrc: 0xaaaaaaaa,
        items: [
          { type: 1, text: 'user@example.com' }, // CNAME
        ],
      },
    ],
  };

  it('encodes and decodes SDES', () => {
    const buf = encodeSdes(sdes);
    expect(buf[1]).toBe(202); // PT=202
    const decoded = decodeSdes(buf);

    expect(decoded.chunks).toHaveLength(1);
    expect(decoded.chunks[0]!.ssrc).toBe(0xaaaaaaaa);
    expect(decoded.chunks[0]!.items).toHaveLength(1);
    expect(decoded.chunks[0]!.items[0]!.type).toBe(1);
    expect(decoded.chunks[0]!.items[0]!.text).toBe('user@example.com');
  });
});

// ---------------------------------------------------------------------------
// 11. Encode/decode BYE
// ---------------------------------------------------------------------------
describe('RTCP BYE', () => {
  it('encodes and decodes BYE without reason', () => {
    const bye: RtcpBye = { ssrcs: [0x11111111, 0x22222222] };
    const decoded = decodeBye(encodeBye(bye));
    expect(decoded.ssrcs).toEqual([0x11111111, 0x22222222]);
    expect(decoded.reason).toBeUndefined();
  });

  it('encodes and decodes BYE with reason', () => {
    const bye: RtcpBye = { ssrcs: [0xdeadbeef], reason: 'session ended' };
    const decoded = decodeBye(encodeBye(bye));
    expect(decoded.ssrcs).toEqual([0xdeadbeef]);
    expect(decoded.reason).toBe('session ended');
  });
});

// ---------------------------------------------------------------------------
// 12. Encode/decode NACK feedback
// ---------------------------------------------------------------------------
describe('RTCP NACK', () => {
  it('encodes and decodes NACK', () => {
    const nack: RtcpNack = {
      senderSsrc: 0x11111111,
      mediaSsrc: 0x22222222,
      pid: 12345,
      blp: 0b1010101010101010,
    };
    const buf = encodeNack(nack);
    expect(buf[1]).toBe(205); // PT=205
    expect(buf[0]! & 0x1f).toBe(1); // FMT=1

    const decoded = decodeNack(buf);
    expect(decoded.senderSsrc).toBe(nack.senderSsrc);
    expect(decoded.mediaSsrc).toBe(nack.mediaSsrc);
    expect(decoded.pid).toBe(nack.pid);
    expect(decoded.blp).toBe(nack.blp);
  });
});

// ---------------------------------------------------------------------------
// 13. Encode/decode PLI
// ---------------------------------------------------------------------------
describe('RTCP PLI', () => {
  it('encodes and decodes PLI', () => {
    const pli: RtcpPli = { senderSsrc: 0xaabbccdd, mediaSsrc: 0x11223344 };
    const buf = encodePli(pli);
    expect(buf[1]).toBe(206); // PT=206
    expect(buf[0]! & 0x1f).toBe(1); // FMT=1

    const decoded = decodePli(buf);
    expect(decoded.senderSsrc).toBe(pli.senderSsrc);
    expect(decoded.mediaSsrc).toBe(pli.mediaSsrc);
  });
});

// ---------------------------------------------------------------------------
// 14. Encode/decode FIR
// ---------------------------------------------------------------------------
describe('RTCP FIR', () => {
  it('encodes and decodes FIR with entries', () => {
    const fir: RtcpFir = {
      senderSsrc: 0x11111111,
      entries: [
        { ssrc: 0xaaaaaaaa, seqNumber: 42 },
        { ssrc: 0xbbbbbbbb, seqNumber: 7 },
      ],
    };
    const buf = encodeFir(fir);
    expect(buf[1]).toBe(206); // PT=206
    expect(buf[0]! & 0x1f).toBe(4); // FMT=4

    const decoded = decodeFir(buf);
    expect(decoded.senderSsrc).toBe(fir.senderSsrc);
    expect(decoded.entries).toHaveLength(2);
    expect(decoded.entries[0]!.ssrc).toBe(0xaaaaaaaa);
    expect(decoded.entries[0]!.seqNumber).toBe(42);
    expect(decoded.entries[1]!.ssrc).toBe(0xbbbbbbbb);
    expect(decoded.entries[1]!.seqNumber).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 15. Encode/decode REMB
// ---------------------------------------------------------------------------
describe('RTCP REMB', () => {
  it('encodes and decodes REMB', () => {
    const remb: RtcpRemb = {
      senderSsrc: 0x11111111,
      mediaSsrc: 0,
      bitrate: 2_500_000, // 2.5 Mbps
      ssrcs: [0xaaaaaaaa, 0xbbbbbbbb],
    };
    const buf = encodeRemb(remb);
    expect(buf[1]).toBe(206); // PT=206
    expect(buf[0]! & 0x1f).toBe(15); // FMT=15
    expect(buf.subarray(12, 16).toString('ascii')).toBe('REMB');

    const decoded = decodeRemb(buf);
    expect(decoded.senderSsrc).toBe(remb.senderSsrc);
    // Bitrate is encoded as mantissa*2^exp so allow small rounding
    expect(decoded.bitrate).toBeCloseTo(remb.bitrate, -3);
    expect(decoded.ssrcs).toHaveLength(2);
    expect(decoded.ssrcs[0]).toBe(0xaaaaaaaa);
    expect(decoded.ssrcs[1]).toBe(0xbbbbbbbb);
  });

  it('round-trips bitrate of 0', () => {
    const remb: RtcpRemb = { senderSsrc: 1, mediaSsrc: 0, bitrate: 0, ssrcs: [] };
    const decoded = decodeRemb(encodeRemb(remb));
    expect(decoded.bitrate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Compound RTCP (SR + SDES)
// ---------------------------------------------------------------------------
describe('Compound RTCP', () => {
  it('encodes and decodes SR + SDES compound packet', () => {
    const sr: RtcpSenderReport = {
      ssrc: 0x12345678,
      ntpTimestamp: 0x8000_0000_0000_0000n,
      rtpTimestamp: 48000,
      packetCount: 200,
      octetCount: 40000,
      reportBlocks: [],
    };
    const sdes: RtcpSdes = {
      chunks: [{ ssrc: 0x12345678, items: [{ type: 1, text: 'test@rtc' }] }],
    };

    const compound = encodeRtcp([
      { type: 'sr', packet: sr },
      { type: 'sdes', packet: sdes },
    ]);
    const decoded = decodeRtcp(compound);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.type).toBe('sr');
    expect(decoded[1]!.type).toBe('sdes');

    if (decoded[0]!.type === 'sr') {
      expect(decoded[0]!.packet.ssrc).toBe(0x12345678);
      expect(decoded[0]!.packet.packetCount).toBe(200);
    }
    if (decoded[1]!.type === 'sdes') {
      expect(decoded[1]!.packet.chunks[0]!.items[0]!.text).toBe('test@rtc');
    }
  });
});

// ---------------------------------------------------------------------------
// 17. seqDiff wrap-around handling
// ---------------------------------------------------------------------------
describe('seqDiff / wrap-around', () => {
  it('handles normal forward difference', () => {
    expect(seqDiff(10, 5)).toBe(5);
    expect(seqDiff(1000, 999)).toBe(1);
  });

  it('handles wrap-around: 1 is "after" 65534', () => {
    // 1 - 65534 should be +3 (1 is 3 ahead of 65534: 65534→65535→0→1)
    expect(seqDiff(1, 65534)).toBe(3);
  });

  it('handles wrap-around: 65534 is "behind" 1', () => {
    expect(seqDiff(65534, 1)).toBe(-3);
  });

  it('returns 0 for equal values', () => {
    expect(seqDiff(100, 100)).toBe(0);
  });

  it('seqLt / seqGt consistency with wrap-around', () => {
    expect(seqLt(65534, 1)).toBe(true);
    expect(seqGt(1, 65534)).toBe(true);
    expect(seqLte(100, 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 18. NTP timestamp conversion
// ---------------------------------------------------------------------------
describe('NTP timestamp conversion', () => {
  it('converts known NTP value to Unix ms', () => {
    // NTP epoch is Jan 1, 1900. Unix epoch is Jan 1, 1970.
    // 70 years + 17 leap days = 2208988800 seconds
    const NTP_UNIX_OFFSET = 2208988800n;
    // NTP for Unix time 0 (Jan 1, 1970 00:00:00 UTC)
    const ntp = NTP_UNIX_OFFSET << 32n;
    expect(ntpToUnix(ntp)).toBe(0);
  });

  it('round-trips Unix ms through NTP', () => {
    const ms = 1_700_000_000_000; // some timestamp in 2023
    const ntp = unixToNtp(ms);
    const back = ntpToUnix(ntp);
    // Allow 1ms rounding error from fractional seconds
    expect(Math.abs(back - ms)).toBeLessThanOrEqual(1);
  });

  it('converts positive Unix time correctly', () => {
    // 1000 ms after Unix epoch
    const ms = 1000;
    const ntp = unixToNtp(ms);
    const back = ntpToUnix(ntp);
    expect(Math.abs(back - ms)).toBeLessThanOrEqual(1);
  });
});
