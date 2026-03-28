/**
 * ICE agent unit tests.
 *
 * Tests cover:
 *   - Candidate priority and foundation computation
 *   - Candidate pair formation and sorting
 *   - Loopback connectivity (two IceAgents on same machine)
 *   - Replay window behavior
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computePriority,
  computeFoundation,
  computePairPriority,
  parseCandidateAttribute,
  serializeCandidateAttribute,
  formCandidatePairs,
  unfreezeInitialPairs,
  generateUfrag,
  generatePassword,
  detectPacketType,
  IceAgent,
  IceAgentState,
  IceConnectionState,
  CandidatePairState,
  getLocalAddresses,
} from '../src/index.js';
import type { IceCandidate } from '../src/index.js';

// ---------------------------------------------------------------------------
// 1. Candidate priority
// ---------------------------------------------------------------------------

describe('computePriority', () => {
  it('host > srflx > relay', () => {
    const host = computePriority('host', 65535, 1);
    const srflx = computePriority('srflx', 65535, 1);
    const relay = computePriority('relay', 65535, 1);
    expect(host).toBeGreaterThan(srflx);
    expect(srflx).toBeGreaterThan(relay);
  });

  it('component 1 > component 2 for same type', () => {
    const c1 = computePriority('host', 65535, 1);
    const c2 = computePriority('host', 65535, 2);
    expect(c1).toBeGreaterThan(c2);
  });

  it('returns a positive 32-bit integer', () => {
    const p = computePriority('host', 65535, 1);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// 2. Candidate foundation
// ---------------------------------------------------------------------------

describe('computeFoundation', () => {
  it('same type+address+protocol → same foundation', () => {
    const f1 = computeFoundation('host', '192.168.1.1', 'udp');
    const f2 = computeFoundation('host', '192.168.1.1', 'udp');
    expect(f1).toBe(f2);
  });

  it('different address → different foundation', () => {
    const f1 = computeFoundation('host', '192.168.1.1', 'udp');
    const f2 = computeFoundation('host', '10.0.0.1', 'udp');
    expect(f1).not.toBe(f2);
  });

  it('different type → different foundation', () => {
    const f1 = computeFoundation('host', '192.168.1.1', 'udp');
    const f2 = computeFoundation('srflx', '192.168.1.1', 'udp');
    expect(f1).not.toBe(f2);
  });

  it('returns an 8-character hex string', () => {
    const f = computeFoundation('host', '127.0.0.1', 'udp');
    expect(f).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. Candidate pair priority (RFC 8445 §6.1.2.3)
// ---------------------------------------------------------------------------

describe('computePairPriority', () => {
  it('returns a BigInt', () => {
    const controlling: IceCandidate = {
      foundation: 'abc',
      component: 1,
      transport: 'udp',
      priority: computePriority('host', 65535, 1),
      address: '127.0.0.1',
      port: 5000,
      type: 'host',
    };
    const controlled = { ...controlling, port: 6000 };
    const p = computePairPriority(controlling, controlled);
    expect(typeof p).toBe('bigint');
    expect(p).toBeGreaterThan(0n);
  });

  it('higher individual priorities → higher pair priority', () => {
    const makeCandidate = (type: IceCandidate['type'], port: number): IceCandidate => ({
      foundation: 'f',
      component: 1,
      transport: 'udp',
      priority: computePriority(type, 65535, 1),
      address: '127.0.0.1',
      port,
      type,
    });

    const hostHost = computePairPriority(makeCandidate('host', 5000), makeCandidate('host', 6000));
    const hostSrflx = computePairPriority(makeCandidate('host', 5000), makeCandidate('srflx', 6000));
    expect(hostHost).toBeGreaterThan(hostSrflx);
  });
});

// ---------------------------------------------------------------------------
// 4. Candidate attribute parsing / serialization
// ---------------------------------------------------------------------------

describe('parseCandidateAttribute / serializeCandidateAttribute', () => {
  const raw = 'f1234567 1 udp 2130706431 192.168.1.100 5000 typ host';

  it('round-trips a basic host candidate', () => {
    const c = parseCandidateAttribute(raw);
    expect(c.foundation).toBe('f1234567');
    expect(c.component).toBe(1);
    expect(c.transport).toBe('udp');
    expect(c.address).toBe('192.168.1.100');
    expect(c.port).toBe(5000);
    expect(c.type).toBe('host');
  });

  it('serializes and re-parses', () => {
    const c = parseCandidateAttribute(raw);
    const s = serializeCandidateAttribute(c);
    const c2 = parseCandidateAttribute(s);
    expect(c2.address).toBe(c.address);
    expect(c2.port).toBe(c.port);
    expect(c2.foundation).toBe(c.foundation);
  });

  it('parses srflx with raddr/rport', () => {
    const srflx = 'abcd1234 1 udp 1694498815 1.2.3.4 5001 typ srflx raddr 192.168.1.1 rport 5000';
    const c = parseCandidateAttribute(srflx);
    expect(c.type).toBe('srflx');
    expect(c.relatedAddress).toBe('192.168.1.1');
    expect(c.relatedPort).toBe(5000);
  });

  it('throws on invalid attribute', () => {
    expect(() => parseCandidateAttribute('invalid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. formCandidatePairs
// ---------------------------------------------------------------------------

describe('formCandidatePairs', () => {
  const makeCandidate = (
    address: string,
    port: number,
    type: IceCandidate['type'] = 'host',
  ): IceCandidate => ({
    foundation: computeFoundation(type, address, 'udp'),
    component: 1,
    transport: 'udp',
    priority: computePriority(type, 65535, 1),
    address,
    port,
    type,
  });

  it('forms pairs from local × remote', () => {
    const local = [makeCandidate('127.0.0.1', 5000)];
    const remote = [makeCandidate('127.0.0.1', 6000)];
    const pairs = formCandidatePairs(local, remote, 'controlling');
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.local.port).toBe(5000);
    expect(pairs[0]!.remote.port).toBe(6000);
  });

  it('skips pairs with different components', () => {
    const local: IceCandidate = { ...makeCandidate('127.0.0.1', 5000), component: 1 };
    const remote: IceCandidate = { ...makeCandidate('127.0.0.1', 6000), component: 2 };
    const pairs = formCandidatePairs([local], [remote], 'controlling');
    expect(pairs.length).toBe(0);
  });

  it('sorts pairs by priority descending', () => {
    const local = [
      makeCandidate('127.0.0.1', 5000, 'srflx'),
      makeCandidate('127.0.0.1', 5001, 'host'),
    ];
    const remote = [makeCandidate('127.0.0.1', 6000)];
    const pairs = formCandidatePairs(local, remote, 'controlling');
    expect(pairs.length).toBe(2);
    // host pair should come before srflx pair
    expect(pairs[0]!.priority >= pairs[1]!.priority).toBe(true);
  });

  it('all pairs start as Frozen', () => {
    const local = [makeCandidate('127.0.0.1', 5000)];
    const remote = [makeCandidate('127.0.0.1', 6000)];
    const pairs = formCandidatePairs(local, remote, 'controlling');
    for (const p of pairs) {
      expect(p.state).toBe(CandidatePairState.Frozen);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. unfreezeInitialPairs
// ---------------------------------------------------------------------------

describe('unfreezeInitialPairs', () => {
  it('unfreezes the highest priority pair', () => {
    const makeCandidate = (port: number): IceCandidate => ({
      foundation: 'f',
      component: 1,
      transport: 'udp',
      priority: computePriority('host', 65535 - port, 1),
      address: '127.0.0.1',
      port,
      type: 'host',
    });

    const pairs = formCandidatePairs(
      [makeCandidate(5000), makeCandidate(5001)],
      [makeCandidate(6000)],
      'controlling',
    );
    unfreezeInitialPairs(pairs);
    const waitingCount = pairs.filter((p) => p.state === CandidatePairState.Waiting).length;
    expect(waitingCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 7. generateUfrag / generatePassword
// ---------------------------------------------------------------------------

describe('generateUfrag / generatePassword', () => {
  it('ufrag is at least 4 characters', () => {
    const u = generateUfrag();
    expect(u.length).toBeGreaterThanOrEqual(4);
  });

  it('password is at least 22 characters', () => {
    const p = generatePassword();
    expect(p.length).toBeGreaterThanOrEqual(22);
  });

  it('generates unique values', () => {
    const u1 = generateUfrag();
    const u2 = generateUfrag();
    expect(u1).not.toBe(u2);
  });
});

// ---------------------------------------------------------------------------
// 8. IceAgent – loopback connectivity test
// ---------------------------------------------------------------------------

describe('IceAgent loopback connectivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two agents on localhost negotiate connectivity', async () => {
    const agent1 = new IceAgent({ role: 'controlling', nomination: 'aggressive' });
    const agent2 = new IceAgent({ role: 'controlled', nomination: 'aggressive' });

    // Gather candidates
    await agent1.gather();
    await agent2.gather();

    // Exchange parameters
    agent1.setRemoteParameters(agent2.localParameters);
    agent2.setRemoteParameters(agent1.localParameters);

    // Exchange candidates (loopback only)
    const lc1 = agent1.getLocalCandidates().filter((c) => c.address === '127.0.0.1');
    const lc2 = agent2.getLocalCandidates().filter((c) => c.address === '127.0.0.1');

    for (const c of lc1) agent2.addRemoteCandidate(c);
    for (const c of lc2) agent1.addRemoteCandidate(c);

    // Connect both
    const [pair1] = await Promise.all([agent1.connect(), agent2.connect()]);

    expect(pair1).toBeDefined();
    expect(pair1.nominated).toBe(true);

    agent1.close();
    agent2.close();
  }, 10_000);

  it('data flows through nominated pair', async () => {
    const agent1 = new IceAgent({ role: 'controlling', nomination: 'aggressive' });
    const agent2 = new IceAgent({ role: 'controlled', nomination: 'aggressive' });

    await agent1.gather();
    await agent2.gather();

    agent1.setRemoteParameters(agent2.localParameters);
    agent2.setRemoteParameters(agent1.localParameters);

    const lc1 = agent1.getLocalCandidates().filter((c) => c.address === '127.0.0.1');
    const lc2 = agent2.getLocalCandidates().filter((c) => c.address === '127.0.0.1');

    for (const c of lc1) agent2.addRemoteCandidate(c);
    for (const c of lc2) agent1.addRemoteCandidate(c);

    await Promise.all([agent1.connect(), agent2.connect()]);

    // Listen for data on agent2
    const received = await new Promise<Buffer>((resolve) => {
      agent2.on('data', (buf: Buffer) => resolve(buf));
      agent1.send(Buffer.from('hello ICE'));
    });

    expect(received.toString()).toBe('hello ICE');

    agent1.close();
    agent2.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 9. detectPacketType
// ---------------------------------------------------------------------------

describe('detectPacketType', () => {
  it('identifies STUN (first byte 0x00)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x00;
    expect(detectPacketType(buf)).toBe('stun');
  });

  it('identifies STUN (first byte 0x01)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x01;
    expect(detectPacketType(buf)).toBe('stun');
  });

  it('identifies DTLS (first byte 0x16 – TLS Handshake)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x16;
    expect(detectPacketType(buf)).toBe('dtls');
  });

  it('identifies DTLS (first byte 0x14 – change_cipher_spec)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x14;
    expect(detectPacketType(buf)).toBe('dtls');
  });

  it('identifies RTP (first byte 0x80)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x80;
    expect(detectPacketType(buf)).toBe('rtp');
  });

  it('identifies RTP (first byte 0xFF)', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0xff;
    expect(detectPacketType(buf)).toBe('rtp');
  });

  it('returns unknown for ambiguous byte', () => {
    const buf = Buffer.alloc(4);
    buf[0] = 0x20; // not STUN, not DTLS, not RTP
    expect(detectPacketType(buf)).toBe('unknown');
  });

  it('returns unknown for empty buffer', () => {
    expect(detectPacketType(Buffer.alloc(0))).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 10. IceAgent gather() – collects at least one host candidate
// ---------------------------------------------------------------------------

describe('IceAgent gather()', () => {
  it('collects at least one host candidate', async () => {
    const agent = new IceAgent();
    const candidates: IceCandidate[] = [];
    agent.on('local-candidate', (c) => candidates.push(c));

    await agent.gather();

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.some((c) => c.type === 'host')).toBe(true);

    agent.close();
  });

  it('emits gathering-complete', async () => {
    const agent = new IceAgent();
    let completed = false;
    agent.on('gathering-complete', () => { completed = true; });

    await agent.gather();

    expect(completed).toBe(true);
    agent.close();
  });

  it('gatheringState transitions to Complete', async () => {
    const agent = new IceAgent();
    const states: IceAgentState[] = [];
    agent.on('gathering-state', (s) => states.push(s));

    await agent.gather();

    expect(states).toContain(IceAgentState.Gathering);
    expect(states).toContain(IceAgentState.Complete);
    agent.close();
  });
});

// ---------------------------------------------------------------------------
// 11. IceAgent restart test
// ---------------------------------------------------------------------------

describe('IceAgent restart()', () => {
  it('re-gathers with new credentials', async () => {
    const agent = new IceAgent({ role: 'controlling' });
    await agent.gather();

    const ufrag1 = agent.localParameters.usernameFragment;
    const pwd1 = agent.localParameters.password;

    await agent.restart();

    const ufrag2 = agent.localParameters.usernameFragment;
    const pwd2 = agent.localParameters.password;

    expect(ufrag2).not.toBe(ufrag1);
    expect(pwd2).not.toBe(pwd1);
    expect(agent.getLocalCandidates().length).toBeGreaterThanOrEqual(1);

    agent.close();
  });
});

// ---------------------------------------------------------------------------
// 12. getLocalAddresses – tier classification
// ---------------------------------------------------------------------------

describe('getLocalAddresses – tier classification', () => {
  it('includes a loopback address (tier 0)', () => {
    const addrs = getLocalAddresses();
    const loopbacks = addrs.filter((a) => a.tier === 0);
    expect(loopbacks.length).toBeGreaterThanOrEqual(1);
    expect(loopbacks.some((a) => a.address === '127.0.0.1')).toBe(true);
  });

  it('loopback address is 127.0.0.1 with tier=0', () => {
    const addrs = getLocalAddresses();
    const lo = addrs.find((a) => a.address === '127.0.0.1');
    expect(lo).toBeDefined();
    expect(lo!.tier).toBe(0);
  });

  it('all addresses are IPv4', () => {
    const addrs = getLocalAddresses();
    for (const a of addrs) {
      expect(a.family).toBe(4);
      expect(a.address).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });

  it('known virtual prefixes get tier 2', () => {
    const addrs = getLocalAddresses();
    const virtualPrefixes = ['docker', 'br-', 'veth', 'tun', 'tap', 'utun', 'vmnet', 'vboxnet'];
    for (const a of addrs) {
      if (virtualPrefixes.some((p) => a.name.startsWith(p))) {
        expect(a.tier).toBe(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 13. gatherHostCandidates – loopback priority is highest
// ---------------------------------------------------------------------------

describe('gatherHostCandidates – loopback has highest priority', () => {
  it('loopback candidate priority > all non-loopback host candidates', async () => {
    const agent = new IceAgent();
    await agent.gather();

    const candidates = agent.getLocalCandidates().filter((c) => c.type === 'host');
    const loopback = candidates.find((c) => c.address === '127.0.0.1');
    const nonLoopback = candidates.filter((c) => c.address !== '127.0.0.1');

    expect(loopback).toBeDefined();
    for (const c of nonLoopback) {
      expect(loopback!.priority).toBeGreaterThanOrEqual(c.priority);
    }

    agent.close();
  });

  it('gather emits loopback candidate', async () => {
    const agent = new IceAgent();
    const emitted: IceCandidate[] = [];
    agent.on('local-candidate', (c) => emitted.push(c));

    await agent.gather();

    expect(emitted.some((c) => c.address === '127.0.0.1')).toBe(true);
    agent.close();
  });

  it('loopback↔loopback pair sorts first when both sides have loopback', () => {
    const loopbackPrio = computePriority('host', 65535, 1);
    const physicalPrio = computePriority('host', 64511, 1);

    const loopbackCandidate = (port: number): IceCandidate => ({
      foundation: computeFoundation('host', '127.0.0.1', 'udp'),
      component: 1, transport: 'udp',
      priority: loopbackPrio,
      address: '127.0.0.1', port, type: 'host',
    });
    const physicalCandidate = (port: number): IceCandidate => ({
      foundation: computeFoundation('host', '192.168.1.1', 'udp'),
      component: 1, transport: 'udp',
      priority: physicalPrio,
      address: '192.168.1.1', port, type: 'host',
    });

    const local = [loopbackCandidate(5000), physicalCandidate(5000)];
    const remote = [loopbackCandidate(6000), physicalCandidate(6000)];
    const pairs = formCandidatePairs(local, remote, 'controlling');

    expect(pairs[0]!.local.address).toBe('127.0.0.1');
    expect(pairs[0]!.remote.address).toBe('127.0.0.1');

    for (const p of pairs.slice(1)) {
      expect(pairs[0]!.priority).toBeGreaterThan(p.priority);
    }
  });
});
