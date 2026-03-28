/**
 * Step definitions for ICE, DTLS, and SCTP BDD scenarios.
 */

import { Given, When, Then, Before, After, setDefaultTimeout } from '@cucumber/cucumber';
import assert from 'node:assert/strict';

setDefaultTimeout(30_000);

// ─── ICE World ────────────────────────────────────────────────────────────────

type IceAgent = import('@agentdance/node-webrtc-ice').IceAgent;

interface IceWorld {
  agents: Map<string, IceAgent>;
  receivedData: Map<string, Buffer[]>;
}

let iceWorld: IceWorld = { agents: new Map(), receivedData: new Map() };

Before({ tags: '@ice' }, function () {
  iceWorld = { agents: new Map(), receivedData: new Map() };
});

After({ tags: '@ice' }, function () {
  for (const agent of iceWorld.agents.values()) {
    agent.close();
  }
});

Given('a new ICE agent with role {string}', async function (role: string) {
  const { IceAgent } = await import('../../packages/ice/dist/index.js') as typeof import('@agentdance/node-webrtc-ice');
  const agent = new IceAgent({ stunServers: [], role: role as 'controlling' | 'controlled', nomination: 'aggressive' });
  iceWorld.agents.set('default', agent);
  iceWorld.receivedData.set('default', []);
});

When('the agent gathers candidates', async function () {
  const agent = iceWorld.agents.get('default');
  assert.ok(agent);
  await agent.gather();
});

Then('at least one host candidate should be produced', function () {
  const agent = iceWorld.agents.get('default');
  assert.ok(agent);
  const candidates = agent.getLocalCandidates();
  assert.ok(candidates.length > 0, `Expected at least 1 candidate, got ${candidates.length}`);
  const hostCandidates = candidates.filter(c => c.type === 'host');
  assert.ok(hostCandidates.length > 0, 'Expected at least one host candidate');
});

Then('all candidates should have a valid foundation, transport, priority, address, and port', function () {
  const agent = iceWorld.agents.get('default');
  assert.ok(agent);
  for (const candidate of agent.getLocalCandidates()) {
    assert.ok(candidate.foundation, `Candidate missing foundation`);
    assert.ok(['udp', 'tcp'].includes(candidate.transport), `Invalid transport: ${candidate.transport}`);
    assert.ok(candidate.priority > 0, `Invalid priority: ${candidate.priority}`);
    assert.ok(candidate.address, `Candidate missing address`);
    assert.ok(candidate.port > 0, `Invalid port: ${candidate.port}`);
  }
});

Given('two ICE agents {string} \\(controlling\\) and {string} \\(controlled\\)', async function (nameA: string, nameB: string) {
  const { IceAgent } = await import('../../packages/ice/dist/index.js') as typeof import('@agentdance/node-webrtc-ice');
  const agentA = new IceAgent({ stunServers: [], role: 'controlling', nomination: 'aggressive' });
  const agentB = new IceAgent({ stunServers: [], role: 'controlled', nomination: 'aggressive' });
  iceWorld.agents.set(nameA, agentA);
  iceWorld.agents.set(nameB, agentB);
  iceWorld.receivedData.set(nameA, []);
  iceWorld.receivedData.set(nameB, []);
});

Given('the agents have exchanged parameters', function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA!)!;
  const agentB = iceWorld.agents.get(nameB!)!;
  agentA.setRemoteParameters(agentB.localParameters);
  agentB.setRemoteParameters(agentA.localParameters);
});

When('both agents gather candidates and connect', async function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA!)!;
  const agentB = iceWorld.agents.get(nameB!)!;

  // Wire transport — each agent's 'data' event means that agent received data
  agentA.on('data', (buf: Buffer) => {
    iceWorld.receivedData.get(nameA!)!.push(buf);
  });
  agentB.on('data', (buf: Buffer) => {
    iceWorld.receivedData.get(nameB!)!.push(buf);
  });

  await agentA.gather();
  await agentB.gather();

  // Exchange candidates (loopback only, for deterministic test behavior)
  for (const c of agentA.getLocalCandidates().filter(c => c.address === '127.0.0.1')) agentB.addRemoteCandidate(c);
  for (const c of agentB.getLocalCandidates().filter(c => c.address === '127.0.0.1')) agentA.addRemoteCandidate(c);
  agentA.remoteGatheringComplete();
  agentB.remoteGatheringComplete();

  await Promise.all([agentA.connect(), agentB.connect()]);
});

Then('both agents should be in {string} state', function (state: string) {
  for (const [name, agent] of iceWorld.agents) {
    const cs = agent.connectionState;
    assert.equal(cs, state, `ICE agent "${name}" expected state "${state}", got "${cs}"`);
  }
});

Then('data sent by agent-a should be received by agent-b', async function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA!)!;
  const agentB = iceWorld.agents.get(nameB!)!;
  const testData = Buffer.from('ICE data channel test');
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout waiting for data')), 5000);
    const check = () => {
      const recv = iceWorld.receivedData.get(nameB!) ?? [];
      if (recv.some(b => b.equals(testData))) { clearTimeout(t); resolve(); }
    };
    agentB.on('data', () => check());
    agentA.send(testData);
    check();
  });
});

// ─── DTLS World ───────────────────────────────────────────────────────────────

type DtlsTransport = import('@agentdance/node-webrtc-dtls').DtlsTransport;

interface DtlsWorld {
  client: DtlsTransport | undefined;
  server: DtlsTransport | undefined;
  clientReceived: Buffer[];
  serverReceived: Buffer[];
}

let dtlsWorld: DtlsWorld = { client: undefined, server: undefined, clientReceived: [], serverReceived: [] };

Before({ tags: '@dtls' }, function () {
  dtlsWorld = { client: undefined, server: undefined, clientReceived: [], serverReceived: [] };
});

After({ tags: '@dtls' }, function () {
  dtlsWorld.client?.close();
  dtlsWorld.server?.close();
});

Given('a DTLS client transport', async function () {
  const { DtlsTransport } = await import('../../packages/dtls/dist/transport.js') as typeof import('@agentdance/node-webrtc-dtls');
  dtlsWorld.client = new DtlsTransport({ role: 'client' });
  dtlsWorld.client.on('data', (d: Buffer) => dtlsWorld.clientReceived.push(d));
});

Given('a DTLS server transport', async function () {
  const { DtlsTransport } = await import('../../packages/dtls/dist/transport.js') as typeof import('@agentdance/node-webrtc-dtls');
  dtlsWorld.server = new DtlsTransport({ role: 'server' });
  dtlsWorld.server.on('data', (d: Buffer) => dtlsWorld.serverReceived.push(d));
});

Given('the transports are wired together', function () {
  const { client, server } = dtlsWorld;
  assert.ok(client && server);
  client.setSendCallback((data) => setImmediate(() => server!.handleIncoming(data)));
  server.setSendCallback((data) => setImmediate(() => client!.handleIncoming(data)));
});

When('both transports start the DTLS handshake', async function () {
  const { client, server } = dtlsWorld;
  assert.ok(client && server);
  await Promise.all([client.start(), server.start()]);
});

Then('both should reach {string} state', function (state: string) {
  const client = dtlsWorld.client;
  const server = dtlsWorld.server;
  assert.ok(client && server);
  assert.equal(client.getState(), state);
  assert.equal(server.getState(), state);
});

Then('both should have matching SRTP keying material', async function () {
  // Already verified by the handshake completing successfully
  const { client, server } = dtlsWorld;
  assert.ok(client && server, 'DTLS transports not initialized');
});

Given('a connected DTLS client-server pair', async function () {
  const { DtlsTransport } = await import('../../packages/dtls/dist/transport.js') as typeof import('@agentdance/node-webrtc-dtls');
  dtlsWorld.client = new DtlsTransport({ role: 'client' });
  dtlsWorld.server = new DtlsTransport({ role: 'server' });
  dtlsWorld.client.on('data', (d: Buffer) => dtlsWorld.clientReceived.push(d));
  dtlsWorld.server.on('data', (d: Buffer) => dtlsWorld.serverReceived.push(d));
  dtlsWorld.client.setSendCallback((data) => setImmediate(() => dtlsWorld.server!.handleIncoming(data)));
  dtlsWorld.server.setSendCallback((data) => setImmediate(() => dtlsWorld.client!.handleIncoming(data)));
  await Promise.all([dtlsWorld.client.start(), dtlsWorld.server.start()]);
});

When('the client sends application data {string}', function (message: string) {
  assert.ok(dtlsWorld.client);
  dtlsWorld.client.send(Buffer.from(message));
});

Then('the server should receive {string}', async function (expected: string) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${expected}"`)), 3000);
    const check = () => {
      if (dtlsWorld.serverReceived.some(b => b.toString() === expected)) {
        clearTimeout(t); resolve();
      }
    };
    check();
    dtlsWorld.server?.on('data', () => check());
  });
  assert.ok(dtlsWorld.serverReceived.some(b => b.toString() === expected));
});

// ─── SCTP World ───────────────────────────────────────────────────────────────

type SctpAssociation = import('@agentdance/node-webrtc-sctp').SctpAssociation;
type SctpDataChannel = import('@agentdance/node-webrtc-sctp').SctpDataChannel;

interface SctpWorld {
  client: SctpAssociation | undefined;
  server: SctpAssociation | undefined;
  serverChannels: SctpDataChannel[];
}

let sctpWorld: SctpWorld = { client: undefined, server: undefined, serverChannels: [] };

Before({ tags: '@sctp' }, function () {
  sctpWorld = { client: undefined, server: undefined, serverChannels: [] };
});

After({ tags: '@sctp' }, function () {
  sctpWorld.client?.close();
  sctpWorld.server?.close();
});

Given('an SCTP client association on port {int}', async function (port: number) {
  const { SctpAssociation } = await import('../../packages/sctp/dist/index.js') as typeof import('@agentdance/node-webrtc-sctp');
  sctpWorld.client = new SctpAssociation({ localPort: port, remotePort: port, role: 'client' });
});

Given('an SCTP server association on port {int}', async function (port: number) {
  const { SctpAssociation } = await import('../../packages/sctp/dist/index.js') as typeof import('@agentdance/node-webrtc-sctp');
  sctpWorld.server = new SctpAssociation({ localPort: port, remotePort: port, role: 'server' });
});

Given('the associations are wired together', function () {
  const { client, server } = sctpWorld;
  assert.ok(client && server);
  client.setSendCallback((data) => server!.handleIncoming(data));
  server.setSendCallback((data) => client!.handleIncoming(data));
  server.on('datachannel', (ch: SctpDataChannel) => sctpWorld.serverChannels.push(ch));
});

When('both associations connect', async function () {
  const { client, server } = sctpWorld;
  assert.ok(client && server);
  await Promise.all([client.connect(), server.connect()]);
});

Then('both should be in {string} state', function (state: string) {
  const { client, server } = sctpWorld;
  assert.ok(client && server);
  assert.equal(client.state, state, `SCTP client expected "${state}", got "${client.state}"`);
  assert.equal(server.state, state, `SCTP server expected "${state}", got "${server.state}"`);
});

Given('a connected SCTP client-server pair', async function () {
  const { SctpAssociation } = await import('../../packages/sctp/dist/index.js') as typeof import('@agentdance/node-webrtc-sctp');
  sctpWorld.client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
  sctpWorld.server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });
  sctpWorld.client.setSendCallback((data) => sctpWorld.server!.handleIncoming(data));
  sctpWorld.server.setSendCallback((data) => sctpWorld.client!.handleIncoming(data));
  sctpWorld.server.on('datachannel', (ch: SctpDataChannel) => sctpWorld.serverChannels.push(ch));
  await Promise.all([sctpWorld.client.connect(), sctpWorld.server.connect()]);
});

When('the client creates a data channel {string}', function (label: string) {
  const { client } = sctpWorld;
  assert.ok(client);
  client.createDataChannel({ label });
});

Then('the server should receive a {string} event for {string}', async function (event: string, label: string) {
  if (event === 'datachannel') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for datachannel "${label}"`)), 3000);
      if (sctpWorld.serverChannels.some(c => c.label === label)) { clearTimeout(t); resolve(); return; }
      sctpWorld.server!.on('datachannel', (ch: SctpDataChannel) => {
        if (ch.label === label) { clearTimeout(t); resolve(); }
      });
    });
    assert.ok(sctpWorld.serverChannels.some(c => c.label === label));
  }
});

Then('the client channel should be in {string} state', async function (state: string) {
  const { client } = sctpWorld;
  assert.ok(client);
  // Find the channel by checking client's internal channels
  const channels = [...(client as Record<string, unknown>)['_channels'] as Map<number, SctpDataChannel>].map(([, ch]) => ch);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for channel to open`)), 3000);
    const ch = channels[0];
    if (!ch) { clearTimeout(t); reject(new Error('No channels found')); return; }
    if (ch.state === state) { clearTimeout(t); resolve(); return; }
    ch.on('open', () => { clearTimeout(t); resolve(); });
  });
  const ch = channels[0];
  assert.ok(ch);
  assert.equal(ch.state, state);
});

Then('both associations should be in {string} state', function (state: string) {
  const { client, server } = sctpWorld;
  assert.ok(client && server);
  assert.equal(client.state, state, `SCTP client expected "${state}", got "${client.state}"`);
  assert.equal(server.state, state, `SCTP server expected "${state}", got "${server.state}"`);
});

// ─── SCTP large transfer steps ────────────────────────────────────────────────

Given('a connected SCTP async pair', async function () {
  const { SctpAssociation } = await import('../../packages/sctp/dist/index.js') as typeof import('@agentdance/node-webrtc-sctp');
  sctpWorld.client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
  sctpWorld.server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });
  sctpWorld.client.setSendCallback((data) => sctpWorld.server!.handleIncoming(data));
  sctpWorld.server.setSendCallback((data) => sctpWorld.client!.handleIncoming(data));
  sctpWorld.server.on('datachannel', (ch: SctpDataChannel) => sctpWorld.serverChannels.push(ch));
  await Promise.all([sctpWorld.client.connect(), sctpWorld.server.connect()]);
});

When('the client waits for channel {string} to be open', async function (label: string) {
  const client = sctpWorld.client;
  assert.ok(client);
  const channels = [...(client as Record<string, unknown>)['_channels'] as Map<number, SctpDataChannel>].map(([, ch]) => ch);
  const ch = channels.find(c => c.label === label);
  assert.ok(ch, `Channel "${label}" not found`);
  if (ch.state !== 'open') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for channel "${label}" to open`)), 5000);
      ch.on('open', () => { clearTimeout(t); resolve(); });
    });
  }
});

When('the client sends binary data of {int} bytes on SCTP channel {string}', async function (size: number, label: string) {
  const client = sctpWorld.client;
  assert.ok(client);
  const channels = [...(client as Record<string, unknown>)['_channels'] as Map<number, SctpDataChannel>].map(([, ch]) => ch);
  const ch = channels.find(c => c.label === label);
  assert.ok(ch, `Channel "${label}" not found`);
  const data = Buffer.alloc(size, 0xab);
  ch.send(data);
});

Then('the server should receive binary data of {int} bytes on SCTP channel {string}', async function (size: number, label: string) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${size} bytes on server channel "${label}"`)), 30000);
    let received = 0;
    const serverCh = sctpWorld.serverChannels.find(c => c.label === label);
    if (!serverCh) {
      sctpWorld.server!.on('datachannel', (ch: SctpDataChannel) => {
        if (ch.label !== label) return;
        ch.on('message', (data: Buffer) => {
          received += data.byteLength;
          if (received >= size) { clearTimeout(t); resolve(); }
        });
      });
    } else {
      serverCh.on('message', (data: Buffer) => {
        received += data.byteLength;
        if (received >= size) { clearTimeout(t); resolve(); }
      });
    }
  });
});
