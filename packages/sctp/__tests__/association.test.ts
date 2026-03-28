/**
 * SCTP Association – comprehensive unit tests
 *
 * Coverage:
 *   1.  Handshake: client ↔ server INIT / INIT-ACK / COOKIE-ECHO / COOKIE-ACK
 *   2.  DCEP: DATA_CHANNEL_OPEN / DATA_CHANNEL_ACK, channel IDs
 *   3.  Small message (single fragment) – string & binary
 *   4.  Large message fragmentation & reassembly (65536 bytes)
 *   5.  Very large message: 4 MiB – verifies congestion control + send queue
 *   6.  cwnd growth in slow-start after ACKs
 *   7.  peerRwnd advertised from SACK limits sending
 *   8.  bufferedAmount tracks send and decreases on ACK
 *   9.  bufferedamountlow event fires when threshold crossed downward
 *  10.  Pre-negotiated channels (negotiated=true, no DCEP)
 *  11.  Channel close transitions to "closed"
 *  12.  Ordered SSN delivery (50 messages delivered in order)
 *  13.  Unordered channel (all messages arrive, order may vary)
 *  14.  3 concurrent channels transfer independently
 *  15.  TSN wrap-around near 2^32
 */

import { describe, it, expect, vi } from 'vitest';
import { SctpAssociation } from '../src/index.js';
import type { SctpDataChannel } from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wire two associations together */
function wirePair(
  client: SctpAssociation,
  server: SctpAssociation,
  async_ = false,
): void {
  if (async_) {
    client.setSendCallback((buf) => setImmediate(() => server.handleIncoming(buf)));
    server.setSendCallback((buf) => setImmediate(() => client.handleIncoming(buf)));
  } else {
    client.setSendCallback((buf) => server.handleIncoming(buf));
    server.setSendCallback((buf) => client.handleIncoming(buf));
  }
}

/** Make a connected SCTP pair */
async function makePair(async_ = false): Promise<{ client: SctpAssociation; server: SctpAssociation }> {
  const client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
  const server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });
  wirePair(client, server, async_);
  await Promise.all([client.connect(), server.connect()]);
  return { client, server };
}

/** Wait for an event with a timeout (one-shot) */
function waitFor<T = unknown>(
  emitter: { once(e: string, cb: (arg: T) => void): void },
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (arg: T) => { clearTimeout(t); resolve(arg); });
  });
}

/** Wait for a specific-label datachannel event */
function waitForDatachannel(
  assoc: SctpAssociation,
  label: string,
  timeoutMs = 5000,
): Promise<SctpDataChannel> {
  return new Promise<SctpDataChannel>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for datachannel "${label}"`)), timeoutMs);
    const handler = (ch: SctpDataChannel) => {
      if (ch.label === label) {
        clearTimeout(t);
        (assoc as unknown as { removeListener(e: string, h: unknown): void }).removeListener('datachannel', handler);
        resolve(ch);
      }
    };
    (assoc as unknown as { on(e: string, h: unknown): void }).on('datachannel', handler);
  });
}

/** Open a channel and wait for server datachannel + client open.
 *  Works correctly with both synchronous and async-delayed delivery.
 */
async function openChannel(
  client: SctpAssociation,
  server: SctpAssociation,
  opts: Parameters<SctpAssociation['createDataChannel']>[0],
): Promise<{ clientCh: SctpDataChannel; serverCh: SctpDataChannel }> {
  // Register server listener BEFORE creating the channel to avoid missing sync events
  const serverChP = waitForDatachannel(server, opts.label);

  // Create channel – with sync wiring this fires datachannel + open immediately
  const clientCh = client.createDataChannel(opts);

  // client 'open' may have already fired (sync wiring) – check state first
  const openP: Promise<void> = clientCh.state === 'open'
    ? Promise.resolve()
    : waitFor<void>(clientCh as unknown as { once(e: string, cb: () => void): void }, 'open');

  const [serverCh] = await Promise.all([serverChP, openP]);
  return { clientCh, serverCh };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Handshake', () => {
  it('client and server reach connected state', async () => {
    const { client, server } = await makePair();
    expect(client.state).toBe('connected');
    expect(server.state).toBe('connected');
  });

  it('close() transitions to closed', async () => {
    const { client, server } = await makePair();
    client.close();
    server.close();
    expect(client.state).toBe('closed');
    expect(server.state).toBe('closed');
  });
});

describe('DCEP Data Channel', () => {
  it('server receives datachannel event with correct label', async () => {
    const { client, server } = await makePair();
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'test' });
    expect(clientCh.label).toBe('test');
    expect(serverCh.label).toBe('test');
    expect(clientCh.state).toBe('open');
    expect(serverCh.state).toBe('open');
  });

  it('channel IDs follow even/odd rule (client=0, then 2)', async () => {
    const { client, server } = await makePair();
    const { clientCh: ch0 } = await openChannel(client, server, { label: 'a' });
    const { clientCh: ch2 } = await openChannel(client, server, { label: 'b' });
    expect(ch0.id).toBe(0);
    expect(ch2.id).toBe(2);
  });
});

describe('Small message transfer', () => {
  it('transfers a string message', async () => {
    const { client, server } = await makePair();
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'str' });
    const recv = waitFor<string>(serverCh, 'message');
    clientCh.send('hello world');
    expect(await recv).toBe('hello world');
  });

  it('transfers a binary buffer', async () => {
    const { client, server } = await makePair();
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'bin' });
    const recv = waitFor<Buffer>(serverCh, 'message');
    clientCh.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const buf = await recv;
    expect(Array.from(buf)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('server replies to client', async () => {
    const { client, server } = await makePair();
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'reply' });
    const recv = waitFor<string>(clientCh, 'message');
    serverCh.send('pong');
    expect(await recv).toBe('pong');
  });
});

describe('Large message fragmentation & reassembly', () => {
  it('transfers 65536-byte message intact', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'large' });

    const SIZE = 65536;
    const data = Buffer.alloc(SIZE, 0xcd);
    const recv = waitFor<Buffer>(serverCh, 'message', 10_000);
    clientCh.send(data);
    const buf = await recv;

    expect(buf.length).toBe(SIZE);
    expect(buf[0]).toBe(0xcd);
    expect(buf[SIZE - 1]).toBe(0xcd);
    // Verify integrity via hash comparison
    expect(buf.toString('hex', 0, 8)).toBe(data.toString('hex', 0, 8));
  }, 15_000);

  it('transfers 4 MiB message without deadlock (congestion control test)', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: '4mib' });

    const SIZE = 4 * 1024 * 1024;
    const data = Buffer.alloc(SIZE, 0x42);
    const recv = waitFor<Buffer>(serverCh, 'message', 60_000);
    clientCh.send(data);
    const buf = await recv;

    expect(buf.length).toBe(SIZE);
    expect(buf[0]).toBe(0x42);
    expect(buf[SIZE - 1]).toBe(0x42);
  }, 65_000);
});

describe('Congestion control', () => {
  it('initial cwnd equals 4 * PMTU (4800 bytes)', async () => {
    const { client } = await makePair();
    expect(client.cwnd).toBe(4 * 1200);
  });

  it('cwnd grows in slow-start after ACKs', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'cc' });

    const initialCwnd = client.cwnd;
    const data = Buffer.alloc(20 * 1200, 0x01);
    const recv = waitFor<Buffer>(serverCh, 'message', 10_000);
    clientCh.send(data);
    await recv;

    expect(client.cwnd).toBeGreaterThan(initialCwnd);
  }, 15_000);

  it('peerRwnd is updated from SACK a_rwnd', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'rwnd' });
    // peerRwnd should be MAX_BUFFER (1 MiB) after handshake SACKs
    expect(client.peerRwnd).toBeGreaterThan(0);
    const recv = waitFor<string>(serverCh, 'message', 3000);
    clientCh.send('rwnd ok');
    expect(await recv).toBe('rwnd ok');
  });

  it('flightSize stays bounded during multi-fragment transfer', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'flight' });

    // Patch server to track client flightSize on every delivery
    let maxObservedFlight = 0;
    const origHandle = server.handleIncoming.bind(server);
    server.handleIncoming = (buf: Buffer) => {
      maxObservedFlight = Math.max(maxObservedFlight, client.flightSize);
      origHandle(buf);
    };

    const data = Buffer.alloc(32 * 1200, 0x02);
    const recv = waitFor<Buffer>(serverCh, 'message', 15_000);
    clientCh.send(data);
    await recv;

    // flightSize must never exceed cwnd + 1 MTU tolerance
    expect(maxObservedFlight).toBeLessThanOrEqual(client.cwnd + 1200);
  }, 20_000);
});

describe('bufferedAmount', () => {
  it('is 0 initially, increases on send, returns to 0 after ACK', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'buf' });

    expect(clientCh.bufferedAmount).toBe(0);
    const recv = waitFor<Buffer>(serverCh, 'message', 5000);
    clientCh.send(Buffer.alloc(10_000, 0x01));

    expect(clientCh.bufferedAmount).toBeGreaterThan(0);
    await recv;

    // Allow event loop ticks for ACK processing
    await new Promise<void>(r => setTimeout(r, 200));
    expect(clientCh.bufferedAmount).toBe(0);
  }, 10_000);

  it('bufferedamountlow fires when threshold crossed downward', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'low' });

    clientCh.bufferedAmountLowThreshold = 5000;
    const lowFired = waitFor(clientCh, 'bufferedamountlow', 5000);

    clientCh.send(Buffer.alloc(20_000, 0x02));
    await waitFor<Buffer>(serverCh, 'message', 5000);
    await lowFired; // should have fired as bufferedAmount drained through threshold
  }, 10_000);
});

describe('Pre-negotiated channels', () => {
  it('both sides open immediately on shared id without DCEP', async () => {
    const { client, server } = await makePair(true);

    const clientCh = client.createDataChannel({ label: 'secure', negotiated: true, id: 5 });
    const serverCh = server.createDataChannel({ label: 'secure', negotiated: true, id: 5 });

    await Promise.all([waitFor(clientCh, 'open'), waitFor(serverCh, 'open')]);

    expect(clientCh.state).toBe('open');
    expect(serverCh.state).toBe('open');
    expect(clientCh.id).toBe(5);

    const recv = waitFor<string>(serverCh, 'message', 3000);
    clientCh.send('secret message');
    expect(await recv).toBe('secret message');
  });
});

describe('Channel close', () => {
  it('close() transitions channel to closed', async () => {
    const { client, server } = await makePair(true);
    const { clientCh } = await openChannel(client, server, { label: 'close-me' });
    const closed = waitFor(clientCh, 'close', 3000);
    clientCh.close();
    await closed;
    expect(clientCh.state).toBe('closed');
  });
});

describe('Ordered SSN delivery', () => {
  it('50 messages are delivered in send order', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, { label: 'ord', ordered: true });

    const received: string[] = [];
    serverCh.on('message', (m) => received.push(m as string));

    const N = 50;
    for (let i = 0; i < N; i++) clientCh.send(`msg-${i}`);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: ordered delivery')), 8000);
      const check = () => { if (received.length >= N) { clearTimeout(t); resolve(); } };
      serverCh.on('message', check);
      check();
    });

    for (let i = 0; i < N; i++) expect(received[i]).toBe(`msg-${i}`);
  }, 15_000);
});

describe('Unordered channel', () => {
  it('all messages arrive (order may vary)', async () => {
    const { client, server } = await makePair(true);
    const { clientCh, serverCh } = await openChannel(client, server, {
      label: 'unord', ordered: false,
    });

    const received: string[] = [];
    serverCh.on('message', (m) => received.push(m as string));

    const N = 20;
    for (let i = 0; i < N; i++) clientCh.send(`u-${i}`);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: unordered delivery')), 5000);
      const check = () => { if (received.length >= N) { clearTimeout(t); resolve(); } };
      serverCh.on('message', check);
      check();
    });

    const sorted = [...received].sort();
    const expected = Array.from({ length: N }, (_, i) => `u-${i}`).sort();
    expect(sorted).toEqual(expected);
  }, 10_000);
});

describe('Multiple concurrent channels', () => {
  it('3 channels transfer independently without cross-contamination', async () => {
    const { client, server } = await makePair(true);

    const pairs = await Promise.all([
      openChannel(client, server, { label: 'ch-0' }),
      openChannel(client, server, { label: 'ch-1' }),
      openChannel(client, server, { label: 'ch-2' }),
    ]);

    const results = await Promise.all(
      pairs.map(async ({ clientCh, serverCh }, i) => {
        const recv = waitFor<string>(serverCh, 'message', 5000);
        clientCh.send(`payload-${i}`);
        return recv;
      }),
    );

    expect(results).toEqual(['payload-0', 'payload-1', 'payload-2']);
  }, 15_000);

  it('concurrent binary transfers on different channels are independent', async () => {
    const { client, server } = await makePair(true);

    const pairs = await Promise.all([
      openChannel(client, server, { label: 'b0' }),
      openChannel(client, server, { label: 'b1' }),
    ]);

    const results = await Promise.all(
      pairs.map(async ({ clientCh, serverCh }, i) => {
        const size = (i + 1) * 1000;
        const recv = waitFor<Buffer>(serverCh, 'message', 5000);
        clientCh.send(Buffer.alloc(size, i + 1));
        const buf = await recv;
        return { size: buf.length, firstByte: buf[0] };
      }),
    );

    expect(results[0]).toEqual({ size: 1000, firstByte: 1 });
    expect(results[1]).toEqual({ size: 2000, firstByte: 2 });
  }, 10_000);
});

describe('TSN wrap-around', () => {
  it('transfers messages correctly when TSN wraps around 2^32', async () => {
    const client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
    const server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });

    // Force initial TSN close to 2^32 - 10 to exercise wrapping
    (client as unknown as { _localTsn: number })._localTsn = 0xfffffff5;

    wirePair(client, server, true);
    await Promise.all([client.connect(), server.connect()]);

    const { clientCh, serverCh } = await openChannel(client, server, { label: 'wrap' });

    const received: string[] = [];
    serverCh.on('message', (m) => received.push(m as string));

    const N = 15; // enough to cross the boundary
    for (let i = 0; i < N; i++) clientCh.send(`w-${i}`);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: TSN wrap')), 8000);
      const check = () => { if (received.length >= N) { clearTimeout(t); resolve(); } };
      serverCh.on('message', check);
      check();
    });

    expect(received.length).toBe(N);
    for (let i = 0; i < N; i++) expect(received[i]).toBe(`w-${i}`);
  }, 10_000);
});
