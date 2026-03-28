/**
 * Cucumber.js step definitions for WebRTC BDD scenarios.
 * Written in ESM JavaScript to avoid TypeScript compilation dependencies.
 */

import { Given, When, Then, Before, After, setDefaultTimeout } from '@cucumber/cucumber';
import assert from 'node:assert/strict';

setDefaultTimeout(120_000);

// ─── World state ─────────────────────────────────────────────────────────────

let world;

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
});

After(function () {
  if (world) {
    for (const pc of world.peers.values()) {
      try { pc.close(); } catch {}
    }
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadWebRTC() {
  const url = new URL('../../packages/webrtc/dist/peer-connection.js', import.meta.url);
  return import(url.href);
}

function getPeer(name) {
  const pc = world.peers.get(name);
  assert.ok(pc, `Peer "${name}" not found`);
  return pc;
}

function waitForEvent(emitter, event, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    emitter.on(event, (arg) => { clearTimeout(t); resolve(arg); });
  });
}

function waitForState(pc, state, prop = 'connectionState', timeout = 15_000) {
  if (pc[prop] === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${prop}="${state}" (current: ${pc[prop]})`)), timeout);
    const eventMap = {
      connectionState: 'connectionstatechange',
      signalingState: 'signalingstatechange',
    };
    pc.on(eventMap[prop], () => {
      if (pc[prop] === state) { clearTimeout(t); resolve(); }
    });
  });
}

function setupAnswererChannelTracking(answerer) {
  answerer.on('datachannel', (ch) => {
    world.incomingChannels.set(ch.label, ch);
    if (!world.receivedMessages.has(ch.label)) world.receivedMessages.set(ch.label, []);
    if (!world.receivedBinaryMessages.has(ch.label)) world.receivedBinaryMessages.set(ch.label, []);
    ch.on('message', (data) => {
      if (typeof data === 'string') {
        world.receivedMessages.get(ch.label).push(data);
      } else {
        // Handle both Buffer and ArrayBuffer
        const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
        world.receivedBinaryMessages.get(ch.label).push(buf);
      }
    });
  });
}

// ─── Background steps ─────────────────────────────────────────────────────────

Given('two RTCPeerConnection instances {string} and {string}', async function (a, b) {
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
  setupAnswererChannelTracking(answerer);
});

async function ensurePeersWithIce() {
  if (!world.peers.has('offerer')) {
    const { RTCPeerConnection } = await loadWebRTC();
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
    setupAnswererChannelTracking(answerer);
  }
}

Given('the offerer has a data channel {string}', async function (label) {
  await ensurePeersWithIce();
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label);
  world.channels.set(label, channel);
  if (!world.receivedMessages.has(label)) world.receivedMessages.set(label, []);
  if (!world.receivedBinaryMessages.has(label)) world.receivedBinaryMessages.set(label, []);
  channel.on('message', (data) => {
    if (typeof data === 'string') {
      world.receivedMessages.get(label).push(data);
    } else {
      world.receivedBinaryMessages.get(label).push(Buffer.from(data));
    }
  });
});

// ─── Negotiation steps ────────────────────────────────────────────────────────

When('the offerer creates an offer', async function () {
  await ensurePeersWithIce();
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

async function doNegotiation() {
  await ensurePeersWithIce();
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  world.offer = await offerer.createOffer();
  await offerer.setLocalDescription(world.offer);
  await answerer.setRemoteDescription(world.offer);
  world.answer = await answerer.createAnswer();
  await answerer.setLocalDescription(world.answer);
  await offerer.setRemoteDescription(world.answer);
}

When('offer\\/answer negotiation completes', async function () {
  await doNegotiation();
});

Then('both peers should reach {string} connection state within {int} seconds', async function (state, seconds) {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  await Promise.all([
    waitForState(offerer, state, 'connectionState', seconds * 1000),
    waitForState(answerer, state, 'connectionState', seconds * 1000),
  ]);
  assert.equal(offerer.connectionState, state);
  assert.equal(answerer.connectionState, state);
});

Given('both peers are connected', async function () {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');
  await Promise.all([
    waitForState(offerer, 'connected', 'connectionState'),
    waitForState(answerer, 'connected', 'connectionState'),
  ]);
});

// ─── Data channel steps ───────────────────────────────────────────────────────

When('the offerer sends {string} on channel {string}', async function (message, label) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found on offerer`);
  if (channel.readyState !== 'open') await waitForEvent(channel, 'open', 5000);
  channel.send(message);
});

Then('the answerer should receive {string} on channel {string}', async function (expected, label) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: "${expected}" on answerer "${label}"`)), 5000);
    const msgs = world.receivedMessages.get(label) ?? [];
    if (msgs.includes(expected)) { clearTimeout(t); resolve(); return; }
    const ch = world.incomingChannels.get(label);
    if (ch) {
      ch.on('message', (data) => {
        const str = typeof data === 'string' ? data : data.toString();
        if (str === expected) { clearTimeout(t); resolve(); }
      });
    } else {
      getPeer('answerer').on('datachannel', (newCh) => {
        if (newCh.label === label) {
          newCh.on('message', (data) => {
            const str = typeof data === 'string' ? data : data.toString();
            if (str === expected) { clearTimeout(t); resolve(); }
          });
        }
      });
    }
  });
});

When('the answerer replies {string} on channel {string}', async function (message, label) {
  const ch = world.incomingChannels.get(label);
  assert.ok(ch, `Answerer has no channel "${label}"`);
  if (ch.readyState !== 'open') await waitForEvent(ch, 'open', 5000);
  ch.send(message);
});

Then('the offerer should receive {string} on channel {string}', async function (expected, label) {
  const msgs = world.receivedMessages.get(label) ?? [];
  if (!msgs.includes(expected)) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: "${expected}" on offerer "${label}"`)), 5000);
      const channel = world.channels.get(label);
      assert.ok(channel, `Channel "${label}" not found`);
      channel.on('message', (data) => {
        const str = typeof data === 'string' ? data : data.toString();
        if (str === expected) { clearTimeout(t); resolve(); }
      });
    });
  }
});

When('the offerer sends binary data of {int} bytes on channel {string}', async function (size, label) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== 'open') await waitForEvent(channel, 'open', 5000);
  // Store the fill byte so integrity check can verify it
  const fillByte = 0xab;
  world._lastSentFill = world._lastSentFill ?? new Map();
  world._lastSentFill.set(label, fillByte);
  channel.send(Buffer.alloc(size, fillByte));
});

Then('the received data on channel {string} should be byte-for-byte correct', async function (label) {
  const fillByte = (world._lastSentFill ?? new Map()).get(label) ?? 0xab;
  const bufs = world.receivedBinaryMessages.get(label) ?? [];
  assert.ok(bufs.length > 0, `No binary data received on channel "${label}"`);
  // Find the most recently received buffer
  const buf = bufs[bufs.length - 1];
  // Every byte must match the fill byte
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== fillByte) {
      assert.fail(`Byte mismatch at offset ${i}: expected 0x${fillByte.toString(16)}, got 0x${buf[i].toString(16)}`);
    }
  }
});

When('the offerer creates a data channel {string} after connection', async function (label) {
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label);
  world.channels.set(label, channel);
  world.receivedMessages.set(label, []);
});

Then('the answerer should receive a data channel named {string}', async function (label) {
  if (!world.incomingChannels.has(label)) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: datachannel "${label}"`)), 5000);
      getPeer('answerer').on('datachannel', (ch) => {
        if (ch.label === label) {
          world.incomingChannels.set(ch.label, ch);
          world.receivedMessages.set(ch.label, []);
          world.receivedBinaryMessages.set(ch.label, []);
          clearTimeout(t); resolve();
        }
      });
    });
  }
  assert.ok(world.incomingChannels.has(label));
});

Then('the channel {string} should be open within {int} seconds', async function (label, seconds) {
  const channel = world.channels.get(label) ?? world.incomingChannels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== 'open') await waitForEvent(channel, 'open', seconds * 1000);
  assert.equal(channel.readyState, 'open');
});

// ─── Signaling state steps ────────────────────────────────────────────────────

Then('the {word} signaling state should be {string}', function (peerName, expected) {
  const pc = getPeer(peerName);
  assert.equal(pc.signalingState, expected);
});

Then('the {word} connection state should be {string}', function (peerName, expected) {
  const pc = getPeer(peerName);
  assert.equal(pc.connectionState, expected);
});

When('the offerer closes the connection', function () {
  getPeer('offerer').close();
});

// ─── New data channel scenarios ───────────────────────────────────────────────

// Large message (fragmentation)
Then('the answerer should receive binary data of {int} bytes on channel {string}', async function (size, label) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: binary ${size}b on "${label}"`)), 15000);
    const check = () => {
      const bufs = world.receivedBinaryMessages.get(label) ?? [];
      if (bufs.some(b => b.length === size)) { clearTimeout(t); resolve(); }
    };
    check();
    const ch = world.incomingChannels.get(label);
    if (ch) {
      ch.on('message', check);
    } else {
      getPeer('answerer').on('datachannel', (newCh) => {
        if (newCh.label === label) {
          newCh.on('message', check);
        }
      });
    }
  });
});

// Pre-negotiated channels
When('both peers create a pre-negotiated channel {string} with id {int}', async function (label, id) {
  const offerer = getPeer('offerer');
  const answerer = getPeer('answerer');

  const offererCh = offerer.createDataChannel(label, { negotiated: true, id });
  const answererCh = answerer.createDataChannel(label, { negotiated: true, id });

  world.channels.set(label, offererCh);
  world.incomingChannels.set(label, answererCh);
  world.receivedMessages.set(label, []);
  world.receivedBinaryMessages.set(label, []);

  answererCh.on('message', (data) => {
    if (typeof data === 'string') {
      world.receivedMessages.get(label).push(data);
    } else {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
      world.receivedBinaryMessages.get(label).push(buf);
    }
  });
});

Then('channel {string} should be open on both peers within {int} seconds', async function (label, seconds) {
  const offererCh = world.channels.get(label);
  const answererCh = world.incomingChannels.get(label);
  assert.ok(offererCh, `Offerer channel "${label}" not found`);
  assert.ok(answererCh, `Answerer channel "${label}" not found`);

  const timeout = seconds * 1000;
  await Promise.all([
    offererCh.readyState !== 'open' ? waitForEvent(offererCh, 'open', timeout) : Promise.resolve(),
    answererCh.readyState !== 'open' ? waitForEvent(answererCh, 'open', timeout) : Promise.resolve(),
  ]);
  assert.equal(offererCh.readyState, 'open');
  assert.equal(answererCh.readyState, 'open');
});

// Unordered channel
Given('the offerer has an unordered data channel {string}', async function (label) {
  await ensurePeersWithIce();
  const offerer = getPeer('offerer');
  const channel = offerer.createDataChannel(label, { ordered: false });
  world.channels.set(label, channel);
  world.receivedMessages.set(label, []);
  world.receivedBinaryMessages.set(label, []);
  channel.on('message', (data) => {
    if (typeof data === 'string') {
      world.receivedMessages.get(label).push(data);
    } else {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
      world.receivedBinaryMessages.get(label).push(buf);
    }
  });
});

// Channel close
When('the channel {string} is closed by the offerer', function (label) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  channel.close();
});

Then('the channel {string} should reach {string} state on the offerer', async function (label, expectedState) {
  const channel = world.channels.get(label);
  assert.ok(channel, `Channel "${label}" not found`);
  if (channel.readyState !== expectedState) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: channel "${label}" state "${expectedState}"`)), 5000);
      channel.on('close', () => { clearTimeout(t); resolve(); });
      channel.on('closing', () => {
        if (expectedState === 'closing') { clearTimeout(t); resolve(); }
      });
    });
  }
  assert.equal(channel.readyState, expectedState);
});

// Stats
Then('the offerer stats should contain a candidate pair entry', async function () {
  const offerer = getPeer('offerer');
  const stats = await offerer.getStats();
  let hasCandidatePair = false;
  stats.forEach((value) => {
    if (value.type === 'candidate-pair') hasCandidatePair = true;
  });
  assert.ok(hasCandidatePair, 'Expected candidate-pair stats entry');
});

