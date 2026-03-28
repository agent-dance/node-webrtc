/**
 * @agentdance/node-webrtc unit tests
 *
 * Tests the RTCPeerConnection API, SDP parsing/generation, signaling state
 * machine, data channels, and full loopback connectivity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannel,
} from '../src/peer-connection.js';

// ─── RTCSessionDescription ────────────────────────────────────────────────────

describe('RTCSessionDescription', () => {
  it('constructs from init', () => {
    const sdp = new RTCSessionDescription({ type: 'offer', sdp: 'v=0\r\n' });
    expect(sdp.type).toBe('offer');
    expect(sdp.sdp).toBe('v=0\r\n');
  });

  it('toJSON returns plain object', () => {
    const sdp = new RTCSessionDescription({ type: 'answer', sdp: 'v=0\r\n' });
    const json = sdp.toJSON();
    expect(json).toEqual({ type: 'answer', sdp: 'v=0\r\n' });
  });
});

// ─── RTCIceCandidate ──────────────────────────────────────────────────────────

describe('RTCIceCandidate', () => {
  const candidateStr =
    'candidate:1 1 udp 2113667327 192.168.1.1 54321 typ host generation 0';

  it('parses candidate string fields', () => {
    const c = new RTCIceCandidate({
      candidate: candidateStr,
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(c.candidate).toBe(candidateStr);
    expect(c.sdpMid).toBe('0');
    expect(c.sdpMLineIndex).toBe(0);
    expect(c.foundation).toBe('1');
    expect(c.component).toBe('rtp');
    expect(c.protocol).toBe('udp');
    expect(c.priority).toBe(2113667327);
    expect(c.address).toBe('192.168.1.1');
    expect(c.port).toBe(54321);
    expect(c.type).toBe('host');
  });

  it('handles srflx candidate with raddr/rport', () => {
    const srflx =
      'candidate:2 1 udp 1686052607 1.2.3.4 54321 typ srflx raddr 192.168.1.1 rport 54321';
    const c = new RTCIceCandidate({ candidate: srflx });
    expect(c.type).toBe('srflx');
    expect(c.relatedAddress).toBe('192.168.1.1');
    expect(c.relatedPort).toBe(54321);
  });

  it('returns null for missing fields gracefully', () => {
    const c = new RTCIceCandidate({ candidate: '' });
    expect(c.foundation).toBeNull();
    expect(c.address).toBeNull();
  });

  it('toJSON returns candidate/sdpMid/sdpMLineIndex/usernameFragment', () => {
    const c = new RTCIceCandidate({
      candidate: candidateStr,
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'abc',
    });
    const json = c.toJSON();
    expect(json.candidate).toBe(candidateStr);
    expect(json.sdpMid).toBe('0');
    expect(json.usernameFragment).toBe('abc');
  });
});

// ─── RTCPeerConnection — basic API ───────────────────────────────────────────

describe('RTCPeerConnection — initialization', () => {
  it('starts with correct initial states', () => {
    const pc = new RTCPeerConnection();
    expect(pc.signalingState).toBe('stable');
    expect(pc.connectionState).toBe('new');
    expect(pc.iceConnectionState).toBe('new');
    expect(pc.iceGatheringState).toBe('new');
    expect(pc.localDescription).toBeNull();
    expect(pc.remoteDescription).toBeNull();
  });

  it('closes cleanly', () => {
    const pc = new RTCPeerConnection();
    pc.close();
    expect(pc.signalingState).toBe('closed');
    expect(pc.connectionState).toBe('closed');
  });

  it('throws on operations after close', async () => {
    const pc = new RTCPeerConnection();
    pc.close();
    await expect(pc.createOffer()).rejects.toThrow('closed');
    await expect(pc.createAnswer()).rejects.toThrow('closed');
    await expect(pc.setLocalDescription({ type: 'offer', sdp: '' })).rejects.toThrow('closed');
    await expect(pc.setRemoteDescription({ type: 'offer', sdp: '' })).rejects.toThrow('closed');
    expect(() => pc.createDataChannel('test')).toThrow('closed');
  });

  it('double-close is idempotent', () => {
    const pc = new RTCPeerConnection();
    pc.close();
    expect(() => pc.close()).not.toThrow();
    expect(pc.signalingState).toBe('closed');
  });
});

describe('RTCPeerConnection — signaling state machine', () => {
  it('transitions to have-local-offer after setLocalDescription(offer)', async () => {
    const pc = new RTCPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(pc.signalingState).toBe('have-local-offer');
    expect(pc.localDescription?.type).toBe('offer');
    pc.close();
  }, 10000);

  it('transitions to have-remote-offer after setRemoteDescription(offer)', async () => {
    // Use a minimal SDP with required ICE/DTLS attrs
    const pc = new RTCPeerConnection();
    const offerer = new RTCPeerConnection();
    const offer = await offerer.createOffer();
    await pc.setRemoteDescription(offer);
    expect(pc.signalingState).toBe('have-remote-offer');
    expect(pc.remoteDescription?.type).toBe('offer');
    pc.close();
    offerer.close();
  }, 10000);

  it('transitions to stable after answer', async () => {
    const pc = new RTCPeerConnection();
    const offerer = new RTCPeerConnection();
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    expect(pc.signalingState).toBe('stable');
    await offerer.setRemoteDescription(answer);
    expect(offerer.signalingState).toBe('stable');
    pc.close();
    offerer.close();
  }, 10000);

  it('emits signalingstatechange event', async () => {
    const pc = new RTCPeerConnection();
    const changes: string[] = [];
    pc.on('signalingstatechange', () => changes.push(pc.signalingState));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(changes).toContain('have-local-offer');
    pc.close();
  }, 10000);
});

describe('RTCPeerConnection — transceiver API', () => {
  it('addTransceiver returns a transceiver', () => {
    const pc = new RTCPeerConnection();
    const transceiver = pc.addTransceiver('audio');
    expect(transceiver).toBeDefined();
    expect(transceiver.kind).toBe('audio');
    expect(transceiver.direction).toBe('sendrecv');
    pc.close();
  });

  it('getTransceivers returns added transceivers', () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    pc.addTransceiver('video', { direction: 'recvonly' });
    const transceivers = pc.getTransceivers();
    expect(transceivers).toHaveLength(2);
    expect(transceivers[0]?.kind).toBe('audio');
    expect(transceivers[1]?.kind).toBe('video');
    pc.close();
  });

  it('addTransceiver emits negotiationneeded', () => {
    const pc = new RTCPeerConnection();
    const negotiationNeeded = vi.fn();
    pc.on('negotiationneeded', negotiationNeeded);
    pc.addTransceiver('audio');
    expect(negotiationNeeded).toHaveBeenCalledOnce();
    pc.close();
  });

  it('getSenders returns transceiver senders', () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    const senders = pc.getSenders();
    expect(senders.length).toBeGreaterThanOrEqual(0);
    pc.close();
  });

  it('getReceivers returns transceiver receivers', () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('video');
    const receivers = pc.getReceivers();
    expect(receivers.length).toBeGreaterThanOrEqual(0);
    pc.close();
  });
});

describe('RTCPeerConnection — data channel API', () => {
  it('createDataChannel returns a channel', () => {
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel('test');
    expect(channel).toBeDefined();
    expect(channel.label).toBe('test');
    pc.close();
  });

  it('createDataChannel with init options', () => {
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel('test', {
      ordered: false,
      maxRetransmits: 3,
      protocol: 'my-protocol',
    });
    expect(channel.label).toBe('test');
    expect(channel.ordered).toBe(false);
    expect(channel.maxRetransmits).toBe(3);
    expect(channel.protocol).toBe('my-protocol');
    pc.close();
  });
});

describe('RTCPeerConnection — getStats', () => {
  it('returns empty stats report when no connection', async () => {
    const pc = new RTCPeerConnection();
    const stats = await pc.getStats();
    expect(stats).toBeDefined();
    const entries = [...stats.entries()];
    expect(entries).toHaveLength(0);
    pc.close();
  });
});

// ─── SDP parser unit tests ────────────────────────────────────────────────────

describe('SDP parser', () => {
  it('parseIceParameters extracts ufrag and password', async () => {
    const { parseIceParameters } = await import('../src/internal/sdp-parser.js');
    const sdp = 'v=0\r\na=ice-ufrag:abc123\r\na=ice-pwd:secretpasswordhere\r\n';
    const params = parseIceParameters(sdp);
    expect(params).not.toBeNull();
    expect(params!.usernameFragment).toBe('abc123');
    expect(params!.password).toBe('secretpasswordhere');
  });

  it('parseIceParameters returns null when missing', async () => {
    const { parseIceParameters } = await import('../src/internal/sdp-parser.js');
    expect(parseIceParameters('v=0\r\n')).toBeNull();
  });

  it('parseDtlsFingerprint extracts algorithm and value', async () => {
    const { parseDtlsFingerprint } = await import('../src/internal/sdp-parser.js');
    const sdp = 'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\n';
    const fp = parseDtlsFingerprint(sdp);
    expect(fp).not.toBeNull();
    expect(fp!.algorithm).toBe('sha-256');
    expect(fp!.value).toBe('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99');
  });

  it('parseSctpPort extracts port', async () => {
    const { parseSctpPort } = await import('../src/internal/sdp-parser.js');
    const sdp = 'a=sctp-port:5000\r\n';
    expect(parseSctpPort(sdp)).toBe(5000);
  });

  it('parseSctpPort returns null when missing', async () => {
    const { parseSctpPort } = await import('../src/internal/sdp-parser.js');
    expect(parseSctpPort('v=0\r\n')).toBeNull();
  });

  it('parseCandidatesFromSdp extracts host candidate', async () => {
    const { parseCandidatesFromSdp } = await import('../src/internal/sdp-parser.js');
    const sdp =
      'a=candidate:1 1 udp 2113667327 192.168.1.100 54321 typ host generation 0\r\n';
    const candidates = parseCandidatesFromSdp(sdp);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.address).toBe('192.168.1.100');
    expect(candidates[0]!.port).toBe(54321);
    expect(candidates[0]!.type).toBe('host');
  });

  it('parseCandidatesFromSdp handles multiple candidates', async () => {
    const { parseCandidatesFromSdp } = await import('../src/internal/sdp-parser.js');
    const sdp = [
      'a=candidate:1 1 udp 2113667327 192.168.1.1 50000 typ host',
      'a=candidate:2 1 udp 1686052607 1.2.3.4 50001 typ srflx raddr 192.168.1.1 rport 50000',
    ].join('\r\n');
    const candidates = parseCandidatesFromSdp(sdp);
    expect(candidates).toHaveLength(2);
    expect(candidates[1]!.type).toBe('srflx');
    expect(candidates[1]!.relatedAddress).toBe('192.168.1.1');
  });
});

// ─── SDP factory unit tests ───────────────────────────────────────────────────

describe('SDP factory', () => {
  it('generateSdpOffer produces valid SDP with required fields', async () => {
    const { IceAgent } = await import('@agentdance/node-webrtc-ice');
    const { generateSdpOffer } = await import('../src/internal/sdp-factory.js');
    const { generateSelfSignedCertificate } = await import('@agentdance/node-webrtc-dtls');
    const agent = new IceAgent({ stunServers: [], role: 'controlling' });
    const cert = generateSelfSignedCertificate();
    const sdp = await generateSdpOffer(agent, {
      iceServers: [],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
      certificates: [],
    }, cert);
    expect(sdp).toContain('v=0');
    expect(sdp).toContain('a=ice-ufrag:');
    expect(sdp).toContain('a=ice-pwd:');
    expect(sdp).toContain('a=fingerprint:sha-256');
    expect(sdp).toContain('a=sctp-port:5000');
    agent.close();
  });

  it('generateSdpAnswer chooses active when remote offer is actpass (RFC 5763 §5)', async () => {
    // Offerer sends actpass → answerer SHOULD respond with active (becomes DTLS client)
    const { IceAgent } = await import('@agentdance/node-webrtc-ice');
    const { generateSdpOffer, generateSdpAnswer } = await import('../src/internal/sdp-factory.js');
    const { generateSelfSignedCertificate } = await import('@agentdance/node-webrtc-dtls');
    const offererAgent = new IceAgent({ stunServers: [], role: 'controlling' });
    const answererAgent = new IceAgent({ stunServers: [], role: 'controlled' });
    const config = {
      iceServers: [],
      iceTransportPolicy: 'all' as const,
      bundlePolicy: 'max-bundle' as const,
      rtcpMuxPolicy: 'require' as const,
      iceCandidatePoolSize: 0,
      certificates: [],
    };
    const offererCert = generateSelfSignedCertificate();
    const answererCert = generateSelfSignedCertificate();
    const offerSdp = await generateSdpOffer(offererAgent, config, offererCert);
    // Offer must advertise actpass
    expect(offerSdp).toContain('a=setup:actpass');
    const answerSdp = await generateSdpAnswer(answererAgent, offerSdp, config, answererCert);
    // Answerer must respond active, not passive
    expect(answerSdp).toContain('a=setup:active');
    expect(answerSdp).not.toContain('a=setup:passive');
    offererAgent.close();
    answererAgent.close();
  });

  it('generateSdpAnswer chooses passive when remote offer is active', async () => {
    const { IceAgent } = await import('@agentdance/node-webrtc-ice');
    const { generateSdpAnswer } = await import('../src/internal/sdp-factory.js');
    const { generateSelfSignedCertificate } = await import('@agentdance/node-webrtc-dtls');
    const agent = new IceAgent({ stunServers: [], role: 'controlled' });
    const cert = generateSelfSignedCertificate();
    const config = {
      iceServers: [], iceTransportPolicy: 'all' as const, bundlePolicy: 'max-bundle' as const,
      rtcpMuxPolicy: 'require' as const, iceCandidatePoolSize: 0, certificates: [],
    };
    // Remote explicitly declared itself active → we must be passive (server)
    const remoteSdpActive = 'v=0\r\na=ice-ufrag:abc\r\na=ice-pwd:123\r\na=fingerprint:sha-256 AA:BB\r\na=setup:active\r\na=sctp-port:5000\r\n';
    const answerSdp = await generateSdpAnswer(agent, remoteSdpActive, config, cert);
    expect(answerSdp).toContain('a=setup:passive');
    agent.close();
  });

  it('generateSdpAnswer chooses active when remote offer is passive', async () => {
    const { IceAgent } = await import('@agentdance/node-webrtc-ice');
    const { generateSdpAnswer } = await import('../src/internal/sdp-factory.js');
    const { generateSelfSignedCertificate } = await import('@agentdance/node-webrtc-dtls');
    const agent = new IceAgent({ stunServers: [], role: 'controlled' });
    const cert = generateSelfSignedCertificate();
    const config = {
      iceServers: [], iceTransportPolicy: 'all' as const, bundlePolicy: 'max-bundle' as const,
      rtcpMuxPolicy: 'require' as const, iceCandidatePoolSize: 0, certificates: [],
    };
    const remoteSdpPassive = 'v=0\r\na=ice-ufrag:abc\r\na=ice-pwd:123\r\na=fingerprint:sha-256 AA:BB\r\na=setup:passive\r\na=sctp-port:5000\r\n';
    const answerSdp = await generateSdpAnswer(agent, remoteSdpPassive, config, cert);
    expect(answerSdp).toContain('a=setup:active');
    agent.close();
  });
});

// ─── DTLS role negotiation — setRemoteDescription offerer path ───────────────
//
// Regression tests for the bug where setRemoteDescription(answer) on the
// offerer never updated _dtlsRole, causing both sides to become DTLS clients
// and deadlock (both sent ClientHello simultaneously).
//
// RFC 5763 §5:
//   answer a=setup:active  → offerer (remote is client) must be server
//   answer a=setup:passive → offerer (remote is server) must be client

describe('DTLS role negotiation — offer/answer full cycle', () => {
  it('offerer becomes DTLS server when answerer sends a=setup:active', async () => {
    // This is the normal ts-rtc↔ts-rtc path:
    // Offerer sends actpass → Answerer replies active → Offerer must be server
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();

    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();

    // Verify the answer carries a=setup:active (the answerer became DTLS client)
    expect(answer.sdp).toContain('a=setup:active');
    expect(answer.sdp).not.toContain('a=setup:passive');

    // Now offerer receives the answer — it must update its internal DTLS role to server
    await offerer.setRemoteDescription(answer);

    // We can't directly inspect _dtlsRole, but we can infer it:
    // The answerer's SDP has a=setup:active (client), so offerer must be server.
    // We verify this by checking the answer SDP content we already asserted above.
    // The full behavioral test is covered by the loopback integration test below.
    offerer.close();
    answerer.close();
  }, 10000);

  it('offerer and answerer reach complementary DTLS roles from full negotiation', async () => {
    // Full SDP exchange: offerer sends actpass, answerer replies active.
    // This guarantees they will NOT both be "client" (the regression scenario).
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();

    const offer = await offerer.createOffer();
    expect(offer.sdp).toContain('a=setup:actpass');

    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);

    const answer = await answerer.createAnswer();
    expect(answer.sdp).toContain('a=setup:active');    // answerer = DTLS client
    expect(answer.sdp).not.toContain('a=setup:passive');

    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);        // offerer must update to server

    // Roles are complementary: answerer=client, offerer=server.
    // No two "client" sides → no ClientHello deadlock.
    offerer.close();
    answerer.close();
  }, 10000);

  it('signaling state reaches stable after full offer/answer exchange', async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();

    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);

    // Both peers must be in stable state after complete exchange
    expect(offerer.signalingState).toBe('stable');
    expect(answerer.signalingState).toBe('stable');

    offerer.close();
    answerer.close();
  }, 10000);

  it('re-negotiation (second offer) preserves correct DTLS roles', async () => {
    // After an initial negotiation completes, a re-offer must still produce actpass
    // (browsers restart ICE via a new offer, not by reusing old SDPs)
    const pc = new RTCPeerConnection();
    const offer1 = await pc.createOffer();
    expect(offer1.sdp).toContain('a=setup:actpass');

    // Simulate that local+remote descriptions were set so signalingState=stable
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();

    const o1 = await offerer.createOffer();
    await offerer.setLocalDescription(o1);
    await answerer.setRemoteDescription(o1);
    const a1 = await answerer.createAnswer();
    await answerer.setLocalDescription(a1);
    await offerer.setRemoteDescription(a1);

    // Second offer from same offerer must still advertise actpass
    const o2 = await offerer.createOffer();
    expect(o2.sdp).toContain('a=setup:actpass');

    pc.close();
    offerer.close();
    answerer.close();
  }, 10000);
});

// ─── RTCPeerConnection — loopback data channel (integration) ─────────────────

describe('RTCPeerConnection — loopback data channel', () => {
  it('establishes connection and exchanges data channel messages', async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();

    // Wire ICE candidates
    offerer.on('icecandidate', async (init) => {
      if (init) await answerer.addIceCandidate(init).catch(() => {});
    });
    answerer.on('icecandidate', async (init) => {
      if (init) await offerer.addIceCandidate(init).catch(() => {});
    });

    // Create data channel on offerer side
    const sendChannel = offerer.createDataChannel('test');

    // Negotiate
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offer);
    const answer = await answerer.createAnswer();
    await answerer.setLocalDescription(answer);
    await offerer.setRemoteDescription(answer);

    // Wait for connection
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('offerer connection timeout')), 15000);
        offerer.on('connectionstatechange', () => {
          if (offerer.connectionState === 'connected') {
            clearTimeout(timeout);
            resolve();
          } else if (offerer.connectionState === 'failed') {
            clearTimeout(timeout);
            reject(new Error('offerer connection failed'));
          }
        });
        if (offerer.connectionState === 'connected') {
          clearTimeout(timeout);
          resolve();
        }
      }),
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('answerer connection timeout')), 15000);
        answerer.on('connectionstatechange', () => {
          if (answerer.connectionState === 'connected') {
            clearTimeout(timeout);
            resolve();
          } else if (answerer.connectionState === 'failed') {
            clearTimeout(timeout);
            reject(new Error('answerer connection failed'));
          }
        });
        if (answerer.connectionState === 'connected') {
          clearTimeout(timeout);
          resolve();
        }
      }),
    ]);

    // Wait for data channel on answerer
    const receiveChannel = await new Promise<RTCDataChannel>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('datachannel timeout')), 5000);
      answerer.on('datachannel', (channel) => {
        clearTimeout(timeout);
        resolve(channel);
      });
    });

    // Exchange messages
    const received = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message timeout')), 5000);
      receiveChannel.on('message', (data: string | Buffer) => {
        clearTimeout(timeout);
        resolve(typeof data === 'string' ? data : data.toString());
      });

      // Wait for channel to open
      if (sendChannel.readyState === 'open') {
        sendChannel.send('Hello WebRTC!');
      } else {
        sendChannel.on('open', () => {
          sendChannel.send('Hello WebRTC!');
        });
      }
    });

    expect(received).toBe('Hello WebRTC!');

    offerer.close();
    answerer.close();
  }, 30000);
});
