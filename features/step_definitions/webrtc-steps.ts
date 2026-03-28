/**
 * Cucumber.js step definitions for WebRTC BDD scenarios.
 *
 * Uses the ts-rtc packages directly (built dist files).
 */

import { Given, When, Then, Before, After, setDefaultTimeout } from '@cucumber/cucumber';
import assert from 'node:assert/strict';

// Increase default timeout for WebRTC connection tests
setDefaultTimeout(30_000);

// ─── World state ─────────────────────────────────────────────────────────────

interface PeerWorld {
  peers: Map<string, import('@agentdance/node-webrtc').RTCPeerConnection>;
  channels: Map<string, import('@agentdance/node-webrtc').RTCDataChannel>; // label → channel
  receivedMessages: Map<string, string[]>; // label → messages
  receivedBinaryMessages: Map<string, Buffer[]>;
  offer: import('@agentdance/node-webrtc').RTCSessionDescriptionInit | undefined;
  answer: import('@agentdance/node-webrtc').RTCSessionDescriptionInit | undefined;
  incomingChannels: Map<string, import('@agentdance/node-webrtc').RTCDataChannel>; // answerer side
}

// ─── Cucumber world declaration ───────────────────────────────────────────────

// We use a module-level context shared across steps in a scenario
let world: PeerWorld;

Before(function () {
  world = {
    peers: new Map(),
    channels: new Map(),
    receivedMessages: new Map(),
    receivedBinaryMessages: new Map(),
    offer: undefined,
    answer: undefined,
    incomingChannels: new Map(),
  };
  dtlsRoleWorld = {
    peersByAlias: new Map(),
    lastOffer: undefined,
    lastAnswer: undefined,
    channels: new Map(),
    incomingChannels: new Map(),
    receivedMessages: new Map(),
  };
});

After(function () {
  for (const pc of world.peers.values()) {
    pc.close();
  }
  for (const pc of dtlsRoleWorld.peersByAlias.values()) {
    pc.close();
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function loadWebRTC() {
  // Dynamic import to ensure dist is loaded
  const mod = await import('../../packages/webrtc/dist/peer-connection.js');
  return mod as typeof import('@agentdance/node-webrtc');
}

function getPeer(name: string): import('@agentdance/node-webrtc').RTCPeerConnection {
  const pc = world.peers.get(name);
  assert.ok(pc, `Peer "${name}" not found`);
  return pc;
}

function waitForEvent<T>(
  emitter: { on: (ev: string, cb: (arg: T) => void) => unknown },
  event: string,
  timeout = 15_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    emitter.on(event, (arg: T) => {
      clearTimeout(t);
      resolve(arg);
    });
  });
}

function waitForState(
  pc: import('@agentdance/node-webrtc').RTCPeerConnection,
  state: string,
  prop: 'connectionState' | 'signalingState' = 'connectionState',
  timeout = 15_000,
): Promise<void> {
  if ((pc as Record<string, unknown>)[prop] === state) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${prop}="${state}" (current: ${(pc as Record<string, unknown>)[prop]})`)), timeout);
    const eventMap: Record<string, string> = {
      connectionState: 'connectionstatechange',
      signalingState: 'signalingstatechange',
    };
    pc.on(eventMap[prop]!, () => {
      if ((pc as Record<string, unknown>)[prop] === state) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

// ─── Background steps ─────────────────────────────────────────────────────────

Given('two RTCPeerConnection instances {string} and {string}', async function (a: string, b: string) {
  const { RTCPeerConnection } = await loadWebRTC();
  world.peers.set(a, new RTCPeerConnection());
  world.peers.set(b, new RTCPeerConnection());
});

Given('trickle ICE candidates are exchanged between peers', function () {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  offerer.on('icecandidate', async (init) => {
    if (init) await answerer.addIceCandidate(init).catch(() => {});
  });
  answerer.on('icecandidate', async (init) => {
    if (init) await offerer.addIceCandidate(init).catch(() => {});
  });
  // Also set up incoming channel tracking on answerer
  answerer.on('datachannel', (ch) => {
    world.incomingChannels.set(ch.label, ch);
    world.receivedMessages.set(ch.label, []);
    world.receivedBinaryMessages.set(ch.label, []);
    ch.on('message', (data: Buffer | string) => {
      if (typeof data === 'string') {
        world.receivedMessages.get(ch.label)!.push(data);
      } else {
        world.receivedBinaryMessages.get(ch.label)!.push(Buffer.from(data));
      }
    });
  });
});

Given('the offerer has a data channel {string}', async function (label: string) {
  const { RTCPeerConnection } = await loadWebRTC();
  // If peer not created yet, create it
  if (!world.peers.has('offerer')) {
    world.peers.set('offerer', new RTCPeerConnection());
    world.peers.set('answerer', new RTCPeerConnection());
    const offerer = getPeer('offerer');
    const answerer = getPeer('answerer');
    offerer.on('icecandidate', async (init) => {
      if (init) await answerer.addIceCandidate(init).catch(() => {});
    });
    answerer.on('icecandidate', async (init) => {
      if (init) await offerer.addIceCandidate(init).catch(() => {});
    });
    answerer.on('datachannel', (ch) => {
      world.incomingChannels.set(ch.label, ch);
      world.receivedMessages.set(ch.label, []);
      world.receivedBinaryMessages.set(ch.label, []);
      ch.on('message', (data: Buffer | string) => {
        if (typeof data === 'string') {
          world.receivedMessages.get(ch.label)!.push(data);
        } else {
          world.receivedBinaryMessages.get(ch.label)!.push(Buffer.from(data));
        }
      });
    });
  }
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label);
  world.channels.set(label, channel);
  world.receivedMessages.set(label, []);
  world.receivedBinaryMessages.set(label, []);
  channel.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      world.receivedMessages.get(label)!.push(data);
    } else {
      world.receivedBinaryMessages.get(label)!.push(Buffer.from(data));
    }
  });
});

// ─── Negotiation steps ────────────────────────────────────────────────────────

When('the offerer creates an offer', async function () {
  const offerer = getPeer('offerer');
  world.offer = await offerer.createOffer();
});

When('the offerer sets the offer as local description', async function () {
  const offerer = getPeer('offerer');
  assert.ok(world.offer, 'No offer created');
  await offerer.setLocalDescription(world.offer);
});

When('the answerer sets the offer as remote description', async function () {
  const answerer = getPeer('answerer');
  assert.ok(world.offer, 'No offer available');
  await answerer.setRemoteDescription(world.offer);
});

When('the answerer creates an answer', async function () {
  const answerer = getPeer('answerer');
  world.answer = await answerer.createAnswer();
});

When('the answerer sets the answer as local description', async function () {
  const answerer = getPeer('answerer');
  assert.ok(world.answer, 'No answer created');
  await answerer.setLocalDescription(world.answer);
});

When('the offerer sets the answer as remote description', async function () {
  const offerer = getPeer('offerer');
  assert.ok(world.answer, 'No answer available');
  await offerer.setRemoteDescription(world.answer);
});

When('offer\\/answer negotiation completes', async function () {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  world.offer = await offerer.createOffer();
  await offerer.setLocalDescription(world.offer);
  await answerer.setRemoteDescription(world.offer);
  world.answer = await answerer.createAnswer();
  await answerer.setLocalDescription(world.answer);
  await offerer.setRemoteDescription(world.answer);
});

Then('both peers should reach {string} connection state within {int} seconds', async function (state: string, _seconds: number) {
  // Check peers from both worlds (dtlsRoleWorld or main world)
  let peers: import('@agentdance/node-webrtc').RTCPeerConnection[] = [...dtlsRoleWorld.peersByAlias.values()];
  if (peers.length === 0) {
    const offerer = world.peers.get('offerer');
    const answerer = world.peers.get('answerer');
    if (offerer) peers.push(offerer);
    if (answerer) peers.push(answerer);
  }
  assert.ok(peers.length >= 2, 'Expected at least 2 peers');
  await Promise.all(peers.map((pc) => waitForState(pc, state, 'connectionState', _seconds * 1000)));
  for (const pc of peers) {
    assert.equal(pc.connectionState, state);
  }
});

Given('both peers are connected', async function () {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  if (offerer.connectionState !== 'connected' || answerer.connectionState !== 'connected') {
    await Promise.all([
      waitForState(offerer, 'connected', 'connectionState'),
      waitForState(answerer, 'connected', 'connectionState'),
    ]);
  }
});

// ─── Data channel steps ───────────────────────────────────────────────────────

When('the offerer sends {string} on channel {string}', async function (message: string, label: string) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found on offerer`);
  // Wait for channel to open
  if (channel.readyState !== 'open') {
    await waitForEvent(channel, 'open', 5000);
  }
  channel.send(message);
});

Then('the answerer should receive {string} on channel {string}', async function (expected: string, label: string) {
  // Wait for message
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for message "${expected}" on answerer channel "${label}"`)), 5000);
    const checkExisting = () => {
      const msgs = world.receivedMessages.get(label) ?? [];
      if (msgs.includes(expected)) { clearTimeout(t); resolve(); return true; }
      return false;
    };
    if (checkExisting()) return;
    const ch = world.incomingChannels.get(label);
    if (ch) {
      ch.on('message', (data: Buffer | string) => {
        const str = typeof data === 'string' ? data : data.toString();
        if (str === expected) { clearTimeout(t); resolve(); }
      });
    } else {
      // Wait for channel to arrive
      const answerer = getPeer('answerer');
      answerer.on('datachannel', (newCh) => {
        if (newCh.label === label) {
          newCh.on('message', (data: Buffer | string) => {
            const str = typeof data === 'string' ? data : data.toString();
            if (str === expected) { clearTimeout(t); resolve(); }
          });
        }
      });
    }
  });
  const msgs = world.receivedMessages.get(label) ?? [];
  assert.ok(msgs.includes(expected), `Expected to receive "${expected}" on channel "${label}", got: ${JSON.stringify(msgs)}`);
});

When('the answerer replies {string} on channel {string}', async function (message: string, label: string) {
  const ch = world.incomingChannels.get(label);
  assert.ok(ch, `Answerer has no channel "${label}"`);
  if (ch.readyState !== 'open') {
    await waitForEvent(ch, 'open', 5000);
  }
  ch.send(message);
});

Then('the offerer should receive {string} on channel {string}', async function (expected: string, label: string) {
  const msgs = world.receivedMessages.get(label) ?? [];
  if (!msgs.includes(expected)) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for "${expected}" on offerer channel "${label}"`)), 5000);
      const channel = world.channels.get(label);
      assert.ok(channel, `Channel "${label}" not found`);
      channel.on('message', (data: Buffer | string) => {
        const str = typeof data === 'string' ? data : data.toString();
        if (str === expected) { clearTimeout(t); resolve(); }
      });
    });
  }
  const updated = world.receivedMessages.get(label) ?? [];
  assert.ok(updated.includes(expected), `Expected "${expected}" on channel "${label}", got: ${JSON.stringify(updated)}`);
});

// Binary data steps

When('the offerer sends binary data of {int} bytes on channel {string}', async function (size: number, label: string) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== 'open') {
    await waitForEvent(channel, 'open', 5000);
  }
  const data = Buffer.alloc(size, 0xab);
  channel.send(data);
  // Store expected size for verification
  world.receivedMessages.set(`__binary_size_${label}`, [String(size)]);
});

Then('the answerer should receive binary data of {int} bytes on channel {string}', async function (size: number, label: string) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for binary data on channel "${label}"`)), 5000);
    const check = () => {
      const bufs = world.receivedBinaryMessages.get(label) ?? [];
      const found = bufs.some((b) => b.length === size);
      if (found) { clearTimeout(t); resolve(); }
    };
    check();
    const ch = world.incomingChannels.get(label);
    if (ch) {
      ch.on('message', () => check());
    }
  });
  const bufs = world.receivedBinaryMessages.get(label) ?? [];
  assert.ok(bufs.some((b) => b.length === size), `Expected binary message of ${size} bytes, got: ${JSON.stringify(bufs.map(b => b.length))}`);
});

// Late channel creation

When('the offerer creates a data channel {string} after connection', async function (label: string) {
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label);
  world.channels.set(label, channel);
  world.receivedMessages.set(label, []);
});

Then('the answerer should receive a data channel named {string}', async function (label: string) {
  if (!world.incomingChannels.has(label)) {
    const answerer = getPeer('answerer');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout waiting for datachannel "${label}"`)), 5000);
      answerer.on('datachannel', (ch) => {
        if (ch.label === label) {
          world.incomingChannels.set(ch.label, ch);
          world.receivedMessages.set(ch.label, []);
          world.receivedBinaryMessages.set(ch.label, []);
          clearTimeout(t);
          resolve();
        }
      });
    });
  }
  assert.ok(world.incomingChannels.has(label), `No datachannel "${label}" received by answerer`);
});

Then('the channel {string} should be open within {int} seconds', async function (label: string, seconds: number) {
  const channel = world.channels.get(label) ?? world.incomingChannels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== 'open') {
    await waitForEvent(channel, 'open', seconds * 1000);
  }
  assert.equal(channel.readyState, 'open', `Channel "${label}" is not open (state: ${channel.readyState})`);
});

Then('channel {string} should be open on both peers within {int} seconds', async function (label: string, seconds: number) {
  const offererCh = world.channels.get(label);
  const answererCh = world.incomingChannels.get(label);
  assert.ok(offererCh, `Offerer channel "${label}" not found`);
  assert.ok(answererCh, `Answerer channel "${label}" not found`);
  const deadline = seconds * 1000;
  await Promise.all([
    offererCh.readyState === 'open'  ? Promise.resolve() : waitForEvent(offererCh,  'open', deadline),
    answererCh.readyState === 'open' ? Promise.resolve() : waitForEvent(answererCh, 'open', deadline),
  ]);
  assert.equal(offererCh.readyState,  'open', `Offerer channel "${label}" not open`);
  assert.equal(answererCh.readyState, 'open', `Answerer channel "${label}" not open`);
});

// ─── Signaling state steps ────────────────────────────────────────────────────

Then('the {word} signaling state should be {string}', function (peerName: string, expected: string) {
  const pc = getPeer(peerName);
  assert.equal(pc.signalingState, expected, `Expected ${peerName} signaling state "${expected}", got "${pc.signalingState}"`);
});

Then('the {word} connection state should be {string}', function (peerName: string, expected: string) {
  const pc = getPeer(peerName);
  assert.equal(pc.connectionState, expected, `Expected ${peerName} connection state "${expected}", got "${pc.connectionState}"`);
});

// ─── Close steps ──────────────────────────────────────────────────────────────

When('the offerer closes the connection', function () {
  const offerer = getPeer('offerer');
  offerer.close();
});

// ─── Stats step ───────────────────────────────────────────────────────────────

Then('the offerer stats should contain a candidate pair entry', async function () {
  const offerer = getPeer('offerer');
  const stats = await offerer.getStats();
  let hasCandidatePair = false;
  for (const [, v] of stats.entries()) {
    if ((v as Record<string, unknown>).type === 'candidate-pair') {
      hasCandidatePair = true;
      break;
    }
  }
  assert.ok(hasCandidatePair, 'Expected stats to contain a candidate-pair entry');
});

// ─── Pre-negotiated channel steps ────────────────────────────────────────────

When('both peers create a pre-negotiated channel {string} with id {int}', async function (label: string, id: number) {
  const { RTCPeerConnection } = await loadWebRTC();
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  const offCh = offerer.createDataChannel(label, { negotiated: true, id });
  const ansCh = answerer.createDataChannel(label, { negotiated: true, id });
  world.channels.set(label, offCh);
  world.incomingChannels.set(label, ansCh);
  world.receivedMessages.set(label, []);
  world.receivedBinaryMessages.set(label, []);
  offCh.on('message', (data: Buffer | string) => {
    const str = typeof data === 'string' ? data : data.toString();
    world.receivedMessages.get(label)!.push(str);
  });
  ansCh.on('message', (data: Buffer | string) => {
    const str = typeof data === 'string' ? data : data.toString();
    world.receivedMessages.get(label)!.push(str);
  });
});

// ─── Unordered channel step ───────────────────────────────────────────────────

Given('the offerer has an unordered data channel {string}', async function (label: string) {
  const { RTCPeerConnection } = await loadWebRTC();
  if (!world.peers.has('offerer')) {
    world.peers.set('offerer', new RTCPeerConnection());
    world.peers.set('answerer', new RTCPeerConnection());
    const offerer = getPeer('offerer');
    const answerer = getPeer('answerer');
    offerer.on('icecandidate', async (init) => {
      if (init) await answerer.addIceCandidate(init).catch(() => {});
    });
    answerer.on('icecandidate', async (init) => {
      if (init) await offerer.addIceCandidate(init).catch(() => {});
    });
    answerer.on('datachannel', (ch) => {
      world.incomingChannels.set(ch.label, ch);
      world.receivedMessages.set(ch.label, []);
      world.receivedBinaryMessages.set(ch.label, []);
      ch.on('message', (data: Buffer | string) => {
        if (typeof data === 'string') {
          world.receivedMessages.get(ch.label)!.push(data);
        } else {
          world.receivedBinaryMessages.get(ch.label)!.push(Buffer.from(data));
        }
      });
    });
  }
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
  world.channels.set(label, channel);
  world.receivedMessages.set(label, []);
  world.receivedBinaryMessages.set(label, []);
  channel.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      world.receivedMessages.get(label)!.push(data);
    } else {
      world.receivedBinaryMessages.get(label)!.push(Buffer.from(data));
    }
  });
});

// ─── Channel close steps ──────────────────────────────────────────────────────

When('the channel {string} is closed by the offerer', function (label: string) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  channel.close();
});

Then('the channel {string} should reach {string} state on the offerer', async function (label: string, state: string) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== state) {
    await waitForEvent(channel, 'close', 3000).catch(() => {});
  }
  assert.equal(channel.readyState, state, `Expected channel "${label}" to be "${state}", got "${channel.readyState}"`);
});

// ─── Large binary integrity check ────────────────────────────────────────────

Then('the received data on channel {string} should be byte-for-byte correct', function (label: string) {
  const bufs = world.receivedBinaryMessages.get(label) ?? [];
  // All received chunks should be filled with 0xab (as sent by the binary step)
  for (const buf of bufs) {
    for (let i = 0; i < Math.min(buf.length, 100); i++) {
      assert.equal(buf[i], 0xab, `Byte mismatch at index ${i} in channel "${label}" data`);
    }
  }
  assert.ok(bufs.length > 0, `No binary data received on channel "${label}"`);
});

// ─── DTLS role interop steps ──────────────────────────────────────────────────
//
// Step definitions for features/webrtc/dtls-role-interop.feature
// These steps use a separate "dtlsRoleWorld" context to avoid polluting the
// main `world` used by peer-connection.feature.
// Note: Before/After hooks are ALREADY registered above — no duplicate hooks.

interface DtlsRoleWorld {
  peersByAlias: Map<string, import('@agentdance/node-webrtc').RTCPeerConnection>;
  lastOffer: import('@agentdance/node-webrtc').RTCSessionDescriptionInit | undefined;
  lastAnswer: import('@agentdance/node-webrtc').RTCSessionDescriptionInit | undefined;
  channels: Map<string, import('@agentdance/node-webrtc').RTCDataChannel>;
  incomingChannels: Map<string, import('@agentdance/node-webrtc').RTCDataChannel>;
  receivedMessages: Map<string, string[]>;
}

let dtlsRoleWorld: DtlsRoleWorld = {
  peersByAlias: new Map(),
  lastOffer: undefined,
  lastAnswer: undefined,
  channels: new Map(),
  incomingChannels: new Map(),
  receivedMessages: new Map(),
};

Given('a new RTCPeerConnection as {word}', async function (alias: string) {
  const { RTCPeerConnection } = await loadWebRTC();
  dtlsRoleWorld.peersByAlias.set(alias, new RTCPeerConnection());
});

Given('ICE candidates are exchanged between {word} and {word}', function (aliasA: string, aliasB: string) {
  const a = dtlsRoleWorld.peersByAlias.get(aliasA);
  const b = dtlsRoleWorld.peersByAlias.get(aliasB);
  assert.ok(a, `Peer "${aliasA}" not found`);
  assert.ok(b, `Peer "${aliasB}" not found`);
  a.on('icecandidate', async (init) => {
    if (init) await b.addIceCandidate(init).catch(() => {});
  });
  b.on('icecandidate', async (init) => {
    if (init) await a.addIceCandidate(init).catch(() => {});
  });
  // Track incoming data channels on answerer
  b.on('datachannel', (ch) => {
    dtlsRoleWorld.incomingChannels.set(ch.label, ch);
    dtlsRoleWorld.receivedMessages.set(ch.label, []);
    ch.on('message', (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString();
      dtlsRoleWorld.receivedMessages.get(ch.label)!.push(str);
    });
  });
});

Given('{word} creates a data channel {string}', async function (alias: string, label: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc, `Peer "${alias}" not found`);
  const ch = pc.createDataChannel(label);
  dtlsRoleWorld.channels.set(label, ch);
  dtlsRoleWorld.receivedMessages.set(label, []);
  ch.on('message', (data: Buffer | string) => {
    const str = typeof data === 'string' ? data : data.toString();
    dtlsRoleWorld.receivedMessages.get(label)!.push(str);
  });
});

When('{word} creates an offer', async function (alias: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc, `Peer "${alias}" not found`);
  dtlsRoleWorld.lastOffer = await pc.createOffer();
});

When('{word} receives the offer as remote description', async function (alias: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc && dtlsRoleWorld.lastOffer, `Peer "${alias}" or offer not found`);
  await pc.setRemoteDescription(dtlsRoleWorld.lastOffer!);
});

When('{word} creates an answer', async function (alias: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc, `Peer "${alias}" not found`);
  dtlsRoleWorld.lastAnswer = await pc.createAnswer();
});

When('{word} receives a remote SDP with {string}', async function (alias: string, setupAttr: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc, `Peer "${alias}" not found`);
  // Build a minimal but valid SDP that includes the requested a=setup attribute
  const minimalSdp = [
    'v=0',
    'o=- 1234567890 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:remoteufrag',
    'a=ice-pwd:remotepasswordremotepassword',
    `a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99`,
    `a=${setupAttr.replace('a=', '')}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';
  dtlsRoleWorld.lastOffer = { type: 'offer', sdp: minimalSdp };
  await pc.setRemoteDescription(dtlsRoleWorld.lastOffer);
});

When('{word} creates an answer from that remote description', async function (alias: string) {
  const pc = dtlsRoleWorld.peersByAlias.get(alias);
  assert.ok(pc, `Peer "${alias}" not found`);
  dtlsRoleWorld.lastAnswer = await pc.createAnswer();
});

When('full offer\\/answer negotiation completes between {word} and {word}', async function (offAlias: string, ansAlias: string) {
  const offerer = dtlsRoleWorld.peersByAlias.get(offAlias);
  const answerer = dtlsRoleWorld.peersByAlias.get(ansAlias);
  assert.ok(offerer, `Peer "${offAlias}" not found`);
  assert.ok(answerer, `Peer "${ansAlias}" not found`);

  dtlsRoleWorld.lastOffer = await offerer.createOffer();
  await offerer.setLocalDescription(dtlsRoleWorld.lastOffer);
  await answerer.setRemoteDescription(dtlsRoleWorld.lastOffer);
  dtlsRoleWorld.lastAnswer = await answerer.createAnswer();
  await answerer.setLocalDescription(dtlsRoleWorld.lastAnswer);
  await offerer.setRemoteDescription(dtlsRoleWorld.lastAnswer);
});

Then('the offer SDP must contain {string}', function (substr: string) {
  assert.ok(dtlsRoleWorld.lastOffer, 'No offer created');
  assert.ok(
    dtlsRoleWorld.lastOffer!.sdp.includes(substr),
    `Expected offer SDP to contain "${substr}", got:\n${dtlsRoleWorld.lastOffer!.sdp}`,
  );
});

Then('the offer SDP must not contain {string}', function (substr: string) {
  assert.ok(dtlsRoleWorld.lastOffer, 'No offer created');
  assert.ok(
    !dtlsRoleWorld.lastOffer!.sdp.includes(substr),
    `Expected offer SDP to NOT contain "${substr}", got:\n${dtlsRoleWorld.lastOffer!.sdp}`,
  );
});

Then('the answer SDP must contain {string}', function (substr: string) {
  assert.ok(dtlsRoleWorld.lastAnswer, 'No answer created');
  assert.ok(
    dtlsRoleWorld.lastAnswer!.sdp.includes(substr),
    `Expected answer SDP to contain "${substr}", got:\n${dtlsRoleWorld.lastAnswer!.sdp}`,
  );
});

Then('the answer SDP must not contain {string}', function (substr: string) {
  assert.ok(dtlsRoleWorld.lastAnswer, 'No answer created');
  assert.ok(
    !dtlsRoleWorld.lastAnswer!.sdp.includes(substr),
    `Expected answer SDP to NOT contain "${substr}", got:\n${dtlsRoleWorld.lastAnswer!.sdp}`,
  );
});

Then('the {word} should be able to send {string} on channel {string}', async function (alias: string, message: string, label: string) {
  const channel = dtlsRoleWorld.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found on ${alias}`);
  if (channel.readyState !== 'open') {
    await waitForEvent(channel, 'open', 5000);
  }
  channel.send(message);
});

Then('the {word} peer should receive {string} on channel {string}', async function (alias: string, expected: string, label: string) {
  // Check if peer is answerer in main world or in dtlsRoleWorld
  const isAnswererInMainWorld = alias === 'answerer' && world.peers.has('answerer');
  const incomingChs = isAnswererInMainWorld ? world.incomingChannels : dtlsRoleWorld.incomingChannels;
  const receivedMsgs = isAnswererInMainWorld ? world.receivedMessages : dtlsRoleWorld.receivedMessages;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${expected}" on ${alias} channel "${label}"`)), 5000);
    const check = () => {
      const msgs = receivedMsgs.get(label) ?? [];
      if (msgs.includes(expected)) { clearTimeout(t); resolve(); }
    };
    check();
    const ch = incomingChs.get(label);
    if (ch) {
      ch.on('message', () => check());
    }
  });
  const msgs = receivedMsgs.get(label) ?? [];
  assert.ok(msgs.includes(expected), `Expected to receive "${expected}" on ${alias} channel "${label}", got: ${JSON.stringify(msgs)}`);
});
