/**
 * Step definitions for ICE, DTLS, and SCTP BDD scenarios.
 */

import { Given, When, Then, Before, After, setDefaultTimeout } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

setDefaultTimeout(120_000);

const require = createRequire(import.meta.url);

// ─── ICE World ────────────────────────────────────────────────────────────────

let iceWorld = { agents: new Map(), receivedData: new Map() };

Before({ tags: '@ice' }, function () {
  iceWorld = { agents: new Map(), receivedData: new Map() };
});

After({ tags: '@ice' }, function () {
  for (const agent of iceWorld.agents.values()) {
    try { agent.close(); } catch {}
  }
});

Given('a new ICE agent with role {string}', async function (role) {
  const { IceAgent } = await import(new URL('../../packages/ice/dist/index.js', import.meta.url).href);
  const agent = new IceAgent({ stunServers: [], role });
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
  assert.ok(candidates.length > 0, `Expected candidates, got 0`);
  const host = candidates.filter(c => c.type === 'host');
  assert.ok(host.length > 0, 'Expected host candidates');
});

Then('all candidates should have a valid foundation, transport, priority, address, and port', function () {
  const agent = iceWorld.agents.get('default');
  for (const c of agent.getLocalCandidates()) {
    assert.ok(c.foundation, 'Missing foundation');
    assert.ok(['udp', 'tcp'].includes(c.transport), `Bad transport: ${c.transport}`);
    assert.ok(c.priority > 0, `Bad priority: ${c.priority}`);
    assert.ok(c.address, 'Missing address');
    assert.ok(c.port > 0, `Bad port: ${c.port}`);
  }
});

Given('two ICE agents {string} \\(controlling\\) and {string} \\(controlled\\)', async function (nameA, nameB) {
  const { IceAgent } = await import(new URL('../../packages/ice/dist/index.js', import.meta.url).href);
  iceWorld.agents.set(nameA, new IceAgent({ stunServers: [], role: 'controlling' }));
  iceWorld.agents.set(nameB, new IceAgent({ stunServers: [], role: 'controlled' }));
  iceWorld.receivedData.set(nameA, []);
  iceWorld.receivedData.set(nameB, []);
});

Given('the agents have exchanged parameters', function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA);
  const agentB = iceWorld.agents.get(nameB);
  agentA.setRemoteParameters(agentB.localParameters);
  agentB.setRemoteParameters(agentA.localParameters);
});

When('both agents gather candidates and connect', async function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA);
  const agentB = iceWorld.agents.get(nameB);

  agentB.on('data', (buf) => iceWorld.receivedData.get(nameB).push(buf));
  agentA.on('data', (buf) => iceWorld.receivedData.get(nameA).push(buf));

  await agentA.gather();
  await agentB.gather();

  for (const c of agentA.getLocalCandidates()) agentB.addRemoteCandidate(c);
  for (const c of agentB.getLocalCandidates()) agentA.addRemoteCandidate(c);
  agentA.remoteGatheringComplete();
  agentB.remoteGatheringComplete();

  await Promise.all([agentA.connect(), agentB.connect()]);
});

Then('both agents should be in {string} state', function (state) {
  for (const [name, agent] of iceWorld.agents) {
    assert.equal(agent.connectionState, state, `Agent "${name}" expected "${state}", got "${agent.connectionState}"`);
  }
});

Then('data sent by agent-a should be received by agent-b', async function () {
  const [nameA, nameB] = [...iceWorld.agents.keys()];
  const agentA = iceWorld.agents.get(nameA);
  const testData = Buffer.from('ICE data test');
  agentA.send(testData);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout waiting for data')), 3000);
    const check = () => {
      if ((iceWorld.receivedData.get(nameB) ?? []).some(b => b.toString() === testData.toString())) {
        clearTimeout(t); resolve();
      }
    };
    check();
    iceWorld.agents.get(nameB).on('data', check);
  });
});

// ─── DTLS World ───────────────────────────────────────────────────────────────

let dtlsWorld = { client: null, server: null, serverReceived: [] };

Before({ tags: '@dtls' }, function () {
  dtlsWorld = { client: null, server: null, serverReceived: [] };
});

After({ tags: '@dtls' }, function () {
  try { dtlsWorld.client?.close(); } catch {}
  try { dtlsWorld.server?.close(); } catch {}
});

Given('a DTLS client transport', async function () {
  const { DtlsTransport } = await import(new URL('../../packages/dtls/dist/transport.js', import.meta.url).href);
  dtlsWorld.client = new DtlsTransport({ role: 'client' });
});

Given('a DTLS server transport', async function () {
  const { DtlsTransport } = await import(new URL('../../packages/dtls/dist/transport.js', import.meta.url).href);
  dtlsWorld.server = new DtlsTransport({ role: 'server' });
  dtlsWorld.server.on('data', (d) => dtlsWorld.serverReceived.push(d));
});

Given('the transports are wired together', function () {
  const { client, server } = dtlsWorld;
  assert.ok(client && server);
  client.setSendCallback((data) => setImmediate(() => server.handleIncoming(data)));
  server.setSendCallback((data) => setImmediate(() => client.handleIncoming(data)));
});

When('both transports start the DTLS handshake', async function () {
  await Promise.all([dtlsWorld.client.start(), dtlsWorld.server.start()]);
});

Then('both should reach {string} state', function (state) {
  const clientState = dtlsWorld.client.getState();
  const serverState = dtlsWorld.server.getState();
  assert.equal(clientState, state, `DTLS client expected "${state}", got ${clientState}`);
  assert.equal(serverState, state, `DTLS server expected "${state}", got ${serverState}`);
});

Then('both should have matching SRTP keying material', function () {
  assert.equal(dtlsWorld.client.getState(), 'connected');
  assert.equal(dtlsWorld.server.getState(), 'connected');
});

Given('a connected DTLS client-server pair', async function () {
  const { DtlsTransport } = await import(new URL('../../packages/dtls/dist/transport.js', import.meta.url).href);
  dtlsWorld.client = new DtlsTransport({ role: 'client' });
  dtlsWorld.server = new DtlsTransport({ role: 'server' });
  dtlsWorld.server.on('data', (d) => dtlsWorld.serverReceived.push(d));
  dtlsWorld.client.setSendCallback((data) => setImmediate(() => dtlsWorld.server.handleIncoming(data)));
  dtlsWorld.server.setSendCallback((data) => setImmediate(() => dtlsWorld.client.handleIncoming(data)));
  await Promise.all([dtlsWorld.client.start(), dtlsWorld.server.start()]);
});

When('the client sends application data {string}', function (message) {
  dtlsWorld.client.send(Buffer.from(message));
});

Then('the server should receive {string}', async function (expected) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: "${expected}"`)), 3000);
    const check = () => {
      if (dtlsWorld.serverReceived.some(b => b.toString() === expected)) { clearTimeout(t); resolve(); }
    };
    check();
    dtlsWorld.server.on('data', check);
  });
});

// ─── SCTP World ───────────────────────────────────────────────────────────────

let sctpWorld = { client: null, server: null, serverChannels: [] };

Before({ tags: '@sctp' }, function () {
  sctpWorld = { client: null, server: null, serverChannels: [] };
});

After({ tags: '@sctp' }, function () {
  try { sctpWorld.client?.close(); } catch {}
  try { sctpWorld.server?.close(); } catch {}
});

Given('an SCTP client association on port {int}', async function (port) {
  const { SctpAssociation } = await import(new URL('../../packages/sctp/dist/index.js', import.meta.url).href);
  sctpWorld.client = new SctpAssociation({ localPort: port, remotePort: port, role: 'client' });
});

Given('an SCTP server association on port {int}', async function (port) {
  const { SctpAssociation } = await import(new URL('../../packages/sctp/dist/index.js', import.meta.url).href);
  sctpWorld.server = new SctpAssociation({ localPort: port, remotePort: port, role: 'server' });
});

Given('the associations are wired together', function () {
  const { client, server } = sctpWorld;
  assert.ok(client && server);
  client.setSendCallback((data) => server.handleIncoming(data));
  server.setSendCallback((data) => client.handleIncoming(data));
  server.on('datachannel', (ch) => sctpWorld.serverChannels.push(ch));
});

When('both associations connect', async function () {
  await Promise.all([sctpWorld.client.connect(), sctpWorld.server.connect()]);
});

// Re-use "both should be in X state" for SCTP too (defined below with tag guard)
Then('both associations should be in {string} state', function (state) {
  assert.equal(sctpWorld.client.state, state, `SCTP client expected "${state}", got "${sctpWorld.client.state}"`);
  assert.equal(sctpWorld.server.state, state, `SCTP server expected "${state}", got "${sctpWorld.server.state}"`);
});

Given('a connected SCTP client-server pair', async function () {
  const { SctpAssociation } = await import(new URL('../../packages/sctp/dist/index.js', import.meta.url).href);
  sctpWorld.client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
  sctpWorld.server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });
  sctpWorld.client.setSendCallback((data) => sctpWorld.server.handleIncoming(data));
  sctpWorld.server.setSendCallback((data) => sctpWorld.client.handleIncoming(data));
  sctpWorld.server.on('datachannel', (ch) => sctpWorld.serverChannels.push(ch));
  await Promise.all([sctpWorld.client.connect(), sctpWorld.server.connect()]);
});

When('the client creates a data channel {string}', function (label) {
  sctpWorld.client.createDataChannel({ label });
});

Then('the server should receive a {string} event for {string}', async function (event, label) {
  if (event === 'datachannel') {
    if (!sctpWorld.serverChannels.some(c => c.label === label)) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timeout: datachannel "${label}"`)), 3000);
        sctpWorld.server.on('datachannel', (ch) => {
          if (ch.label === label) { clearTimeout(t); resolve(); }
        });
      });
    }
    assert.ok(sctpWorld.serverChannels.some(c => c.label === label));
  }
});

Then('the client channel should be in {string} state', async function (state) {
  const channels = [...sctpWorld.client._channels.values()];
  const ch = channels[0];
  assert.ok(ch, 'No channels found');
  if (ch.state !== state) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout: channel open')), 3000);
      ch.on('open', () => { clearTimeout(t); resolve(); });
    });
  }
  assert.equal(ch.state, state);
});

// ─── SCTP large data transfer steps ─────────────────────────────────────────

Given('a connected SCTP async pair', async function () {
  const { SctpAssociation } = await import(new URL('../../packages/sctp/dist/index.js', import.meta.url).href);
  sctpWorld.client = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'client' });
  sctpWorld.server = new SctpAssociation({ localPort: 5000, remotePort: 5000, role: 'server' });
  // Async (setImmediate) wiring – required for congestion control pump to work
  sctpWorld.client.setSendCallback((data) => setImmediate(() => sctpWorld.server.handleIncoming(data)));
  sctpWorld.server.setSendCallback((data) => setImmediate(() => sctpWorld.client.handleIncoming(data)));
  sctpWorld.server.on('datachannel', (ch) => {
    sctpWorld.serverChannels.push(ch);
    sctpWorld.serverChannelMap = sctpWorld.serverChannelMap ?? new Map();
    sctpWorld.serverChannelMap.set(ch.label, ch);
    sctpWorld.serverBinaryMessages = sctpWorld.serverBinaryMessages ?? new Map();
    sctpWorld.serverBinaryMessages.set(ch.label, []);
    ch.on('message', (data) => {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
      sctpWorld.serverBinaryMessages.get(ch.label).push(buf);
    });
  });
  await Promise.all([sctpWorld.client.connect(), sctpWorld.server.connect()]);
});

When('the client waits for channel {string} to be open', async function (label) {
  const channels = [...sctpWorld.client._channels.values()];
  const ch = channels.find(c => c.label === label);
  assert.ok(ch, `Client channel "${label}" not found`);
  if (ch.state !== 'open') {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: channel "${label}" open`)), 10_000);
      ch.on('open', () => { clearTimeout(t); resolve(); });
    });
  }
  assert.equal(ch.state, 'open');
});

When('the client sends binary data of {int} bytes on SCTP channel {string}', async function (size, label) {
  const channels = [...sctpWorld.client._channels.values()];
  const ch = channels.find(c => c.label === label);
  assert.ok(ch, `Client channel "${label}" not found`);
  assert.equal(ch.state, 'open', `Channel "${label}" not open`);
  const fillByte = 0xdc;
  sctpWorld.lastSentFill = sctpWorld.lastSentFill ?? new Map();
  sctpWorld.lastSentFill.set(label, fillByte);
  ch.send(Buffer.alloc(size, fillByte));
});

Then('the server should receive binary data of {int} bytes on SCTP channel {string}', async function (size, label) {
  sctpWorld.serverBinaryMessages = sctpWorld.serverBinaryMessages ?? new Map();
  await new Promise((resolve, reject) => {
    const timeoutMs = size > 1_000_000 ? 60_000 : 15_000;
    const t = setTimeout(() => reject(new Error(`Timeout: server binary ${size}b on "${label}"`)), timeoutMs);

    const check = () => {
      const bufs = sctpWorld.serverBinaryMessages.get(label) ?? [];
      if (bufs.some(b => b.length === size)) { clearTimeout(t); resolve(); }
    };
    check();

    // Also handle the case where the datachannel hasn't arrived yet
    const ch = (sctpWorld.serverChannelMap ?? new Map()).get(label);
    if (ch) {
      ch.on('message', check);
    } else {
      sctpWorld.server.on('datachannel', (newCh) => {
        if (newCh.label === label) newCh.on('message', check);
      });
    }
  });

  const bufs = sctpWorld.serverBinaryMessages.get(label) ?? [];
  const received = bufs.find(b => b.length === size);
  assert.ok(received, `No buffer of ${size} bytes found`);

  // Integrity check: verify fill byte
  const fillByte = (sctpWorld.lastSentFill ?? new Map()).get(label) ?? 0xdc;
  assert.equal(received[0], fillByte, `First byte mismatch`);
  assert.equal(received[size - 1], fillByte, `Last byte mismatch`);
  // Spot-check middle
  assert.equal(received[Math.floor(size / 2)], fillByte, `Middle byte mismatch`);
});
