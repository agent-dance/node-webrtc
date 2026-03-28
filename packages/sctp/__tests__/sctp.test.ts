/**
 * SCTP unit tests – packet codec, association handshake, data channel DCEP.
 */

import { describe, it, expect } from 'vitest';
import {
  crc32c,
  encodeSctpPacket,
  decodeSctpPacket,
  encodeDataChunk,
  decodeDataChunk,
  encodeDcepOpen,
  encodeDcepAck,
  decodeDcep,
  SctpAssociation,
  Ppid,
  DcepChannelType,
  ChunkType,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// 1. CRC-32c
// ---------------------------------------------------------------------------

describe('crc32c', () => {
  it('returns 0 for empty buffer', () => {
    // CRC-32c of empty is 0x00000000
    expect(crc32c(Buffer.alloc(0))).toBe(0x00000000);
  });

  it('is deterministic', () => {
    const buf = Buffer.from('hello sctp world');
    expect(crc32c(buf)).toBe(crc32c(buf));
  });

  it('differs for different inputs', () => {
    const a = crc32c(Buffer.from('abc'));
    const b = crc32c(Buffer.from('abd'));
    expect(a).not.toBe(b);
  });

  it('is consistent with known value', () => {
    // Known CRC-32c for "123456789"
    const val = crc32c(Buffer.from('123456789'));
    expect(val).toBe(0xe3069283);
  });
});

// ---------------------------------------------------------------------------
// 2. SCTP packet encode/decode
// ---------------------------------------------------------------------------

describe('encodeSctpPacket / decodeSctpPacket', () => {
  it('round-trips a minimal packet', () => {
    const pkt = {
      header: {
        srcPort: 5000,
        dstPort: 5001,
        verificationTag: 0x12345678,
        checksum: 0,
      },
      chunks: [],
    };
    const buf = encodeSctpPacket(pkt);
    const decoded = decodeSctpPacket(buf);
    expect(decoded.header.srcPort).toBe(5000);
    expect(decoded.header.dstPort).toBe(5001);
    expect(decoded.header.verificationTag).toBe(0x12345678);
  });

  it('computes and embeds checksum', () => {
    const pkt = {
      header: { srcPort: 5000, dstPort: 5001, verificationTag: 1, checksum: 0 },
      chunks: [{ type: ChunkType.COOKIE_ACK, flags: 0, value: Buffer.alloc(0) }],
    };
    const buf = encodeSctpPacket(pkt);
    // checksum is at bytes 8–11
    const cs = buf.readUInt32BE(8);
    expect(cs).toBeGreaterThan(0);
  });

  it('round-trips a packet with DATA chunk', () => {
    const pkt = {
      header: { srcPort: 1, dstPort: 2, verificationTag: 99, checksum: 0 },
      chunks: [
        {
          type: ChunkType.DATA,
          flags: 0x03, // B+E
          value: Buffer.from([0,0,0,1, 0,0, 0,0, 0,0,0,51, 104,101,108,108,111]), // tsn=1,sid=0,ssn=0,ppid=51,data='hello'
        },
      ],
    };
    const buf = encodeSctpPacket(pkt);
    const decoded = decodeSctpPacket(buf);
    expect(decoded.chunks.length).toBe(1);
    expect(decoded.chunks[0]!.type).toBe(ChunkType.DATA);
  });

  it('throws on too-short buffer', () => {
    expect(() => decodeSctpPacket(Buffer.alloc(8))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. DATA chunk encode/decode
// ---------------------------------------------------------------------------

describe('encodeDataChunk / decodeDataChunk', () => {
  it('round-trips a DATA chunk payload', () => {
    const original = {
      tsn: 0xdeadbeef,
      streamId: 3,
      ssn: 7,
      ppid: Ppid.STRING,
      userData: Buffer.from('hello data channel'),
      beginning: true,
      ending: true,
      unordered: false,
    };

    const chunk = encodeDataChunk(original);
    const decoded = decodeDataChunk(chunk);

    expect(decoded.tsn).toBe(original.tsn);
    expect(decoded.streamId).toBe(original.streamId);
    expect(decoded.ssn).toBe(original.ssn);
    expect(decoded.ppid).toBe(original.ppid);
    expect(decoded.userData.toString()).toBe('hello data channel');
    expect(decoded.beginning).toBe(true);
    expect(decoded.ending).toBe(true);
    expect(decoded.unordered).toBe(false);
  });

  it('encodes unordered flag correctly', () => {
    const chunk = encodeDataChunk({
      tsn: 1, streamId: 0, ssn: 0, ppid: Ppid.BINARY,
      userData: Buffer.from('x'), beginning: true, ending: true, unordered: true,
    });
    const decoded = decodeDataChunk(chunk);
    expect(decoded.unordered).toBe(true);
  });

  it('throws on too-short chunk', () => {
    expect(() => decodeDataChunk({ type: 0, flags: 0, value: Buffer.alloc(8) })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. DCEP encoding/decoding
// ---------------------------------------------------------------------------

describe('DCEP encode/decode', () => {
  it('round-trips DATA_CHANNEL_OPEN', () => {
    const buf = encodeDcepOpen({
      type: 0x03,
      channelType: DcepChannelType.RELIABLE,
      priority: 0,
      reliabilityParam: 0,
      label: 'chat',
      protocol: 'json',
    });

    const msg = decodeDcep(buf);
    expect(msg.type).toBe(0x03);
    if (msg.type === 0x03) {
      expect(msg.label).toBe('chat');
      expect(msg.protocol).toBe('json');
      expect(msg.channelType).toBe(DcepChannelType.RELIABLE);
    }
  });

  it('round-trips DATA_CHANNEL_ACK', () => {
    const buf = encodeDcepAck();
    const msg = decodeDcep(buf);
    expect(msg.type).toBe(0x02);
  });

  it('throws on empty buffer', () => {
    expect(() => decodeDcep(Buffer.alloc(0))).toThrow();
  });

  it('encodes label and protocol correctly', () => {
    const label = 'my-channel-with-a-long-name';
    const protocol = '';
    const buf = encodeDcepOpen({
      type: 0x03,
      channelType: DcepChannelType.RELIABLE_UNORDERED,
      priority: 256,
      reliabilityParam: 0,
      label,
      protocol,
    });
    const msg = decodeDcep(buf);
    if (msg.type === 0x03) {
      expect(msg.label).toBe(label);
      expect(msg.protocol).toBe(protocol);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SctpAssociation loopback
// ---------------------------------------------------------------------------

describe('SctpAssociation loopback', () => {
  function createLoopback() {
    const client = new SctpAssociation({
      localPort: 5000,
      remotePort: 5001,
      role: 'client',
    });

    const server = new SctpAssociation({
      localPort: 5001,
      remotePort: 5000,
      role: 'server',
    });

    // Wire them together
    client.setSendCallback((buf) => server.handleIncoming(buf));
    server.setSendCallback((buf) => client.handleIncoming(buf));

    return { client, server };
  }

  it('completes the 4-way handshake', async () => {
    const { client, server } = createLoopback();

    // The handshake is synchronous once connect() fires, so we just need
    // to ensure both sides reach 'connected'.
    await Promise.all([client.connect(5000), server.connect(5000)]);

    expect(client.state).toBe('connected');
    expect(server.state).toBe('connected');
  }, 5000);

  it('creates data channel and exchanges messages', async () => {
    const { client, server } = createLoopback();

    await Promise.all([client.connect(5000), server.connect(5000)]);

    expect(client.state).toBe('connected');
    expect(server.state).toBe('connected');

    // Create channel from client; server should receive DATA_CHANNEL_OPEN synchronously
    const serverChannelPromise = new Promise<import('../src/index.js').SctpDataChannel>(
      (resolve) => server.on('datachannel', resolve),
    );

    const clientCh = client.createDataChannel({ label: 'test', ordered: true });

    const serverCh = await serverChannelPromise;
    expect(serverCh.label).toBe('test');
    expect(serverCh.state).toBe('open');

    // Client channel should now be open (server sent DCEP ACK synchronously)
    expect(clientCh.state).toBe('open');

    // Send from client to server
    const received = await new Promise<string>((resolve) => {
      serverCh.on('message', (data) => resolve(data as string));
      clientCh.send('hello server');
    });

    expect(received).toBe('hello server');

    client.close();
    server.close();
  }, 5000);

  it('handles binary messages', async () => {
    const { client, server } = createLoopback();

    await Promise.all([client.connect(5000), server.connect(5000)]);

    const serverChannelPromise = new Promise<import('../src/index.js').SctpDataChannel>(
      (resolve) => server.on('datachannel', resolve),
    );

    const clientCh = client.createDataChannel({ label: 'binary', ordered: true });
    const serverCh = await serverChannelPromise;

    // clientCh should be open since DCEP ACK was sent synchronously
    expect(clientCh.state).toBe('open');

    const received = await new Promise<Buffer>((resolve) => {
      serverCh.on('message', (data) => resolve(data as Buffer));
      clientCh.send(Buffer.from([1, 2, 3, 4]));
    });

    expect(received).toBeInstanceOf(Buffer);
    expect(Array.from(received)).toEqual([1, 2, 3, 4]);

    client.close();
    server.close();
  }, 5000);
});
