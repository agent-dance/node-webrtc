import { describe, it, expect } from 'vitest';
import {
  parse,
  serialize,
  parseCandidate,
  serializeCandidate,
  createOffer,
  createAnswer,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CHROME_OFFER = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
a=extmap-allow-mixed
a=msid-semantic: WMS
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:someUfrag
a=ice-pwd:somePassword12345678901234
a=ice-options:trickle
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=sendrecv
a=msid:stream1 audio1
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=fmtp:63 111/111
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:13 CN/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:126 telephone-event/8000
a=ssrc:1234567890 cname:some-cname
a=ssrc:1234567890 msid:stream1 audio1
a=candidate:foundation1 1 udp 2113667327 192.168.1.1 54321 typ host generation 0 ufrag someUfrag network-id 1
a=candidate:foundation2 1 udp 1677724415 1.2.3.4 54321 typ srflx raddr 192.168.1.1 rport 54321 generation 0 ufrag someUfrag network-id 1
m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 127 121 125 107 108 109 124 120 123 119
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:someUfrag
a=ice-pwd:somePassword12345678901234
a=ice-options:trickle
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=mid:1
a=sendrecv
a=rtcp-mux
a=rtcp-rsize
a=rtpmap:96 VP8/90000
a=rtcp-fb:96 goog-remb
a=rtcp-fb:96 transport-cc
a=rtcp-fb:96 ccm fir
a=rtcp-fb:96 nack
a=rtcp-fb:96 nack pli
a=rtpmap:97 rtx/90000
a=fmtp:97 apt=96
a=rtpmap:98 VP9/90000
a=rtpmap:99 rtx/90000
a=fmtp:99 apt=98
a=rtpmap:100 H264/90000
a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
a=ssrc-group:FID 2222222222 3333333333
a=ssrc:2222222222 cname:some-cname
a=ssrc:3333333333 cname:some-cname
`;

const DATACHANNEL_SDP = `v=0
o=- 1234567890 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:dcUfrag
a=ice-pwd:dcPassword1234567890123456
a=ice-options:trickle
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
`;

const ANSWER_SDP = `v=0
o=- 9876543210 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
a=msid-semantic: WMS
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:answerUfrag
a=ice-pwd:answerPassword12345678901
a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00
a=setup:passive
a=mid:0
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
m=video 9 UDP/TLS/RTP/SAVPF 96
c=IN IP4 0.0.0.0
a=ice-ufrag:answerUfrag
a=ice-pwd:answerPassword12345678901
a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00
a=setup:passive
a=mid:1
a=recvonly
a=rtcp-mux
a=rtcp-rsize
a=rtpmap:96 VP8/90000
`;

// ---------------------------------------------------------------------------
// 1. Parse a real browser offer SDP (Chrome format)
// ---------------------------------------------------------------------------

describe('parse Chrome offer SDP', () => {
  const sdp = parse(CHROME_OFFER);

  it('parses session-level fields', () => {
    expect(sdp.version).toBe(0);
    expect(sdp.origin.username).toBe('-');
    expect(sdp.origin.sessionId).toBe('4611731400430051336');
    expect(sdp.origin.sessionVersion).toBe(2);
    expect(sdp.origin.networkType).toBe('IN');
    expect(sdp.origin.addressType).toBe('IP4');
    expect(sdp.origin.unicastAddress).toBe('127.0.0.1');
    expect(sdp.sessionName).toBe('-');
    expect(sdp.timing.startTime).toBe(0);
    expect(sdp.timing.stopTime).toBe(0);
  });

  it('parses BUNDLE group', () => {
    expect(sdp.groups).toHaveLength(1);
    expect(sdp.groups[0]!.semantic).toBe('BUNDLE');
    expect(sdp.groups[0]!.mids).toEqual(['0', '1']);
  });

  it('parses msid-semantic', () => {
    expect(sdp.msidSemantic).toBe('WMS');
  });

  it('parses two media sections', () => {
    expect(sdp.mediaDescriptions).toHaveLength(2);
  });

  describe('audio media', () => {
    const audio = sdp.mediaDescriptions[0]!;

    it('has correct type and port', () => {
      expect(audio.type).toBe('audio');
      expect(audio.port).toBe(9);
      expect(audio.protocol).toBe('UDP/TLS/RTP/SAVPF');
    });

    it('has correct payload types', () => {
      expect(audio.payloadTypes).toEqual([111, 63, 9, 0, 8, 13, 110, 126]);
    });

    it('parses connection', () => {
      expect(audio.connection).toEqual({
        networkType: 'IN',
        addressType: 'IP4',
        address: '0.0.0.0',
      });
    });

    it('parses rtcp attribute', () => {
      expect(audio.rtcp).toEqual({
        port: 9,
        networkType: 'IN',
        addressType: 'IP4',
        address: '0.0.0.0',
      });
    });

    it('parses ICE credentials', () => {
      expect(audio.iceUfrag).toBe('someUfrag');
      expect(audio.icePwd).toBe('somePassword12345678901234');
      expect(audio.iceOptions).toBe('trickle');
    });

    it('parses setup', () => {
      expect(audio.setup).toBe('actpass');
    });

    it('parses mid', () => {
      expect(audio.mid).toBe('0');
    });

    it('parses direction', () => {
      expect(audio.direction).toBe('sendrecv');
    });

    it('parses rtcp-mux', () => {
      expect(audio.rtcpMux).toBe(true);
    });

    it('parses extmaps', () => {
      expect(audio.extmaps).toHaveLength(2);
      expect(audio.extmaps[0]).toMatchObject({
        id: 1,
        uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
      });
      expect(audio.extmaps[1]).toMatchObject({
        id: 2,
        uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
      });
    });

    it('parses rtpmaps', () => {
      expect(audio.rtpMaps).toHaveLength(8);
      const opus = audio.rtpMaps[0]!;
      expect(opus.payloadType).toBe(111);
      expect(opus.encoding).toBe('opus');
      expect(opus.clockRate).toBe(48000);
      expect(opus.encodingParams).toBe('2');
    });

    it('parses fmtp', () => {
      const fmtp111 = audio.fmtps.find((f) => f.payloadType === 111);
      expect(fmtp111?.parameters).toBe('minptime=10;useinbandfec=1');
    });

    it('parses rtcp-fb', () => {
      const fb = audio.rtcpFbs.find(
        (f) => f.payloadType === 111 && f.type === 'transport-cc',
      );
      expect(fb).toBeDefined();
    });

    it('parses msid', () => {
      expect(audio.msid).toBe('stream1 audio1');
    });

    it('parses SSRCs', () => {
      const cname = audio.ssrcs.find(
        (s) => s.attribute === 'cname',
      );
      expect(cname?.id).toBe(1234567890);
      expect(cname?.value).toBe('some-cname');
    });

    it('parses ICE candidates', () => {
      expect(audio.candidates).toHaveLength(2);
      const host = audio.candidates[0]!;
      expect(host.foundation).toBe('foundation1');
      expect(host.component).toBe(1);
      expect(host.transport).toBe('udp');
      expect(host.priority).toBe(2113667327);
      expect(host.address).toBe('192.168.1.1');
      expect(host.port).toBe(54321);
      expect(host.type).toBe('host');
      expect(host.generation).toBe(0);
      expect(host.ufrag).toBe('someUfrag');
      expect(host.networkId).toBe(1);

      const srflx = audio.candidates[1]!;
      expect(srflx.type).toBe('srflx');
      expect(srflx.relatedAddress).toBe('192.168.1.1');
      expect(srflx.relatedPort).toBe(54321);
    });
  });

  describe('video media', () => {
    const video = sdp.mediaDescriptions[1]!;

    it('has correct type', () => {
      expect(video.type).toBe('video');
      expect(video.mid).toBe('1');
    });

    it('parses rtcp-rsize', () => {
      expect(video.rtcpRsize).toBe(true);
    });

    it('parses multiple rtcp-fb entries', () => {
      const vp8Fbs = video.rtcpFbs.filter((f) => f.payloadType === 96);
      expect(vp8Fbs).toHaveLength(5);
      const ccmFir = vp8Fbs.find(
        (f) => f.type === 'ccm' && f.parameter === 'fir',
      );
      expect(ccmFir).toBeDefined();
      const nackPli = vp8Fbs.find(
        (f) => f.type === 'nack' && f.parameter === 'pli',
      );
      expect(nackPli).toBeDefined();
    });

    it('parses SSRC group (FID)', () => {
      expect(video.ssrcGroups).toHaveLength(1);
      const fid = video.ssrcGroups[0]!;
      expect(fid.semantic).toBe('FID');
      expect(fid.ssrcIds).toEqual([2222222222, 3333333333]);
    });

    it('parses multiple SSRCs', () => {
      expect(video.ssrcs).toHaveLength(2);
      expect(video.ssrcs[0]!.id).toBe(2222222222);
      expect(video.ssrcs[1]!.id).toBe(3333333333);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Parse a real browser answer SDP
// ---------------------------------------------------------------------------

describe('parse answer SDP', () => {
  const sdp = parse(ANSWER_SDP);

  it('parses basic fields', () => {
    expect(sdp.version).toBe(0);
    expect(sdp.origin.sessionId).toBe('9876543210');
    expect(sdp.groups[0]!.mids).toEqual(['0', '1']);
  });

  it('parses audio direction sendrecv', () => {
    expect(sdp.mediaDescriptions[0]!.direction).toBe('sendrecv');
    expect(sdp.mediaDescriptions[0]!.setup).toBe('passive');
  });

  it('parses video direction recvonly', () => {
    expect(sdp.mediaDescriptions[1]!.direction).toBe('recvonly');
  });
});

// ---------------------------------------------------------------------------
// 3. Round-trip: parse then serialize should produce equivalent SDP
// ---------------------------------------------------------------------------

describe('round-trip: parse → serialize → parse', () => {
  it('audio media fields survive round-trip', () => {
    const original = parse(CHROME_OFFER);
    const serialized = serialize(original);
    const reparsed = parse(serialized);

    expect(reparsed.version).toBe(original.version);
    expect(reparsed.origin).toEqual(original.origin);
    expect(reparsed.sessionName).toEqual(original.sessionName);
    expect(reparsed.timing).toEqual(original.timing);
    expect(reparsed.groups).toEqual(original.groups);
    expect(reparsed.msidSemantic).toEqual(original.msidSemantic);
    expect(reparsed.mediaDescriptions).toHaveLength(
      original.mediaDescriptions.length,
    );

    const origAudio = original.mediaDescriptions[0]!;
    const reparsedAudio = reparsed.mediaDescriptions[0]!;

    expect(reparsedAudio.type).toBe(origAudio.type);
    expect(reparsedAudio.port).toBe(origAudio.port);
    expect(reparsedAudio.protocol).toBe(origAudio.protocol);
    expect(reparsedAudio.payloadTypes).toEqual(origAudio.payloadTypes);
    expect(reparsedAudio.iceUfrag).toBe(origAudio.iceUfrag);
    expect(reparsedAudio.icePwd).toBe(origAudio.icePwd);
    expect(reparsedAudio.fingerprint).toEqual(origAudio.fingerprint);
    expect(reparsedAudio.setup).toBe(origAudio.setup);
    expect(reparsedAudio.mid).toBe(origAudio.mid);
    expect(reparsedAudio.direction).toBe(origAudio.direction);
    expect(reparsedAudio.rtcpMux).toBe(origAudio.rtcpMux);
    expect(reparsedAudio.rtpMaps).toEqual(origAudio.rtpMaps);
    expect(reparsedAudio.fmtps).toEqual(origAudio.fmtps);
    expect(reparsedAudio.rtcpFbs).toEqual(origAudio.rtcpFbs);
    expect(reparsedAudio.ssrcs).toEqual(origAudio.ssrcs);
    expect(reparsedAudio.extmaps).toEqual(origAudio.extmaps);
  });

  it('video media fields survive round-trip', () => {
    const original = parse(CHROME_OFFER);
    const serialized = serialize(original);
    const reparsed = parse(serialized);

    const origVideo = original.mediaDescriptions[1]!;
    const reparsedVideo = reparsed.mediaDescriptions[1]!;

    expect(reparsedVideo.rtcpRsize).toBe(origVideo.rtcpRsize);
    expect(reparsedVideo.ssrcGroups).toEqual(origVideo.ssrcGroups);
    expect(reparsedVideo.ssrcs).toEqual(origVideo.ssrcs);
    expect(reparsedVideo.rtpMaps).toEqual(origVideo.rtpMaps);
    expect(reparsedVideo.fmtps).toEqual(origVideo.fmtps);
    expect(reparsedVideo.rtcpFbs).toEqual(origVideo.rtcpFbs);
  });

  it('candidates survive round-trip', () => {
    const original = parse(CHROME_OFFER);
    const serialized = serialize(original);
    const reparsed = parse(serialized);

    const origCands = original.mediaDescriptions[0]!.candidates;
    const reparsedCands = reparsed.mediaDescriptions[0]!.candidates;
    expect(reparsedCands).toEqual(origCands);
  });
});

// ---------------------------------------------------------------------------
// 4. Parse ICE candidates
// ---------------------------------------------------------------------------

describe('parseCandidate', () => {
  it('parses a host candidate', () => {
    const c = parseCandidate(
      'foundation1 1 udp 2113667327 192.168.1.1 54321 typ host generation 0 ufrag someUfrag network-id 1',
    );
    expect(c.foundation).toBe('foundation1');
    expect(c.component).toBe(1);
    expect(c.transport).toBe('udp');
    expect(c.priority).toBe(2113667327);
    expect(c.address).toBe('192.168.1.1');
    expect(c.port).toBe(54321);
    expect(c.type).toBe('host');
    expect(c.generation).toBe(0);
    expect(c.ufrag).toBe('someUfrag');
    expect(c.networkId).toBe(1);
    expect(c.relatedAddress).toBeUndefined();
  });

  it('parses a srflx candidate', () => {
    const c = parseCandidate(
      'foundation2 1 udp 1677724415 1.2.3.4 54321 typ srflx raddr 192.168.1.1 rport 54321 generation 0',
    );
    expect(c.type).toBe('srflx');
    expect(c.relatedAddress).toBe('192.168.1.1');
    expect(c.relatedPort).toBe(54321);
  });

  it('parses a relay candidate', () => {
    const c = parseCandidate(
      'foundation3 1 udp 41885439 10.0.0.1 3478 typ relay raddr 1.2.3.4 rport 54321 generation 0',
    );
    expect(c.type).toBe('relay');
    expect(c.relatedAddress).toBe('1.2.3.4');
  });

  it('parses a TCP candidate with tcptype', () => {
    const c = parseCandidate(
      'foundation4 1 tcp 1518214911 192.168.1.1 9 typ host tcptype active generation 0',
    );
    expect(c.transport).toBe('tcp');
    expect(c.tcpType).toBe('active');
  });

  it('parses candidate with a= prefix', () => {
    const c = parseCandidate(
      'a=candidate:foundation1 1 udp 2113667327 192.168.1.1 54321 typ host',
    );
    expect(c.foundation).toBe('foundation1');
    expect(c.type).toBe('host');
  });

  it('parses candidate with network-cost', () => {
    const c = parseCandidate(
      'foundation5 1 udp 2113667327 10.0.0.1 1234 typ host network-id 2 network-cost 50',
    );
    expect(c.networkId).toBe(2);
    expect(c.networkCost).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 5. Parse DTLS fingerprint
// ---------------------------------------------------------------------------

describe('DTLS fingerprint', () => {
  it('parses sha-256 fingerprint', () => {
    const sdp = parse(CHROME_OFFER);
    const fp = sdp.mediaDescriptions[0]!.fingerprint!;
    expect(fp.algorithm).toBe('sha-256');
    expect(fp.value).toBe(
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    );
  });

  it('parses sha-1 fingerprint', () => {
    const sdpStr = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=fingerprint:sha-1 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD
a=rtpmap:111 opus/48000/2
`;
    const sdp = parse(sdpStr);
    expect(sdp.mediaDescriptions[0]!.fingerprint!.algorithm).toBe('sha-1');
  });
});

// ---------------------------------------------------------------------------
// 6. Parse all media directions
// ---------------------------------------------------------------------------

describe('media directions', () => {
  function makeMinimalSdp(direction: string): string {
    return `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=${direction}
a=rtpmap:111 opus/48000/2
`;
  }

  it('parses sendrecv', () => {
    expect(parse(makeMinimalSdp('sendrecv')).mediaDescriptions[0]!.direction).toBe('sendrecv');
  });

  it('parses sendonly', () => {
    expect(parse(makeMinimalSdp('sendonly')).mediaDescriptions[0]!.direction).toBe('sendonly');
  });

  it('parses recvonly', () => {
    expect(parse(makeMinimalSdp('recvonly')).mediaDescriptions[0]!.direction).toBe('recvonly');
  });

  it('parses inactive', () => {
    expect(parse(makeMinimalSdp('inactive')).mediaDescriptions[0]!.direction).toBe('inactive');
  });
});

// ---------------------------------------------------------------------------
// 7. Parse data channel SDP (application/webrtc-datachannel)
// ---------------------------------------------------------------------------

describe('data channel SDP', () => {
  const sdp = parse(DATACHANNEL_SDP);

  it('parses application media section', () => {
    expect(sdp.mediaDescriptions).toHaveLength(1);
    const m = sdp.mediaDescriptions[0]!;
    expect(m.type).toBe('application');
    expect(m.protocol).toBe('UDP/DTLS/SCTP');
  });

  it('parses sctp-port', () => {
    expect(sdp.mediaDescriptions[0]!.sctpPort).toBe(5000);
  });

  it('parses max-message-size', () => {
    expect(sdp.mediaDescriptions[0]!.maxMessageSize).toBe(262144);
  });

  it('parses ice credentials', () => {
    const m = sdp.mediaDescriptions[0]!;
    expect(m.iceUfrag).toBe('dcUfrag');
    expect(m.iceOptions).toBe('trickle');
  });
});

// ---------------------------------------------------------------------------
// 8. Serialize and re-parse should be equivalent
// ---------------------------------------------------------------------------

describe('serialize', () => {
  it('serialized output is valid SDP (starts with v=0)', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    expect(out.startsWith('v=0')).toBe(true);
  });

  it('uses CRLF line endings', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    const lines = out.split('\r\n');
    expect(lines.length).toBeGreaterThan(10);
  });

  it('ends with CRLF', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('serializeCandidate round-trips', () => {
    const original = parseCandidate(
      'foundation2 1 udp 1677724415 1.2.3.4 54321 typ srflx raddr 192.168.1.1 rport 54321 generation 0 ufrag someUfrag network-id 1',
    );
    const line = serializeCandidate(original);
    const reparsed = parseCandidate(line);
    expect(reparsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// 9. Parse multiple SSRCs and SSRC groups
// ---------------------------------------------------------------------------

describe('SSRCs and SSRC groups', () => {
  it('parses ssrc-group:FID with two SSRCs', () => {
    const video = parse(CHROME_OFFER).mediaDescriptions[1]!;
    expect(video.ssrcGroups[0]!.semantic).toBe('FID');
    expect(video.ssrcGroups[0]!.ssrcIds).toHaveLength(2);
  });

  it('parses ssrc cname and msid lines for same SSRC id', () => {
    const audio = parse(CHROME_OFFER).mediaDescriptions[0]!;
    const cname = audio.ssrcs.find(
      (s) => s.id === 1234567890 && s.attribute === 'cname',
    );
    expect(cname?.value).toBe('some-cname');

    const msid = audio.ssrcs.find(
      (s) => s.id === 1234567890 && s.attribute === 'msid',
    );
    expect(msid?.value).toBe('stream1 audio1');
  });

  it('serializes ssrc groups and parses them back', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    expect(out).toContain('a=ssrc-group:FID 2222222222 3333333333');
  });

  it('serializes ssrc entries and parses them back', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    expect(out).toContain('a=ssrc:2222222222 cname:some-cname');
    expect(out).toContain('a=ssrc:3333333333 cname:some-cname');
  });
});

// ---------------------------------------------------------------------------
// 10. Parse extmap attributes
// ---------------------------------------------------------------------------

describe('extmap attributes', () => {
  it('parses simple extmap', () => {
    const audio = parse(CHROME_OFFER).mediaDescriptions[0]!;
    const ext1 = audio.extmaps[0]!;
    expect(ext1.id).toBe(1);
    expect(ext1.uri).toBe('urn:ietf:params:rtp-hdrext:ssrc-audio-level');
    expect(ext1.direction).toBeUndefined();
    expect(ext1.attributes).toBeUndefined();
  });

  it('parses extmap with direction', () => {
    const sdpStr = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=extmap:3/sendrecv urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=rtpmap:111 opus/48000/2
`;
    const sdp = parse(sdpStr);
    const ext = sdp.mediaDescriptions[0]!.extmaps[0]!;
    expect(ext.id).toBe(3);
    expect(ext.direction).toBe('sendrecv');
    expect(ext.uri).toBe('urn:ietf:params:rtp-hdrext:ssrc-audio-level');
  });

  it('parses extmap with attributes', () => {
    const sdpStr = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=extmap:4 urn:ietf:params:rtp-hdrext:encrypt urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=rtpmap:111 opus/48000/2
`;
    const sdp = parse(sdpStr);
    const ext = sdp.mediaDescriptions[0]!.extmaps[0]!;
    expect(ext.id).toBe(4);
    expect(ext.attributes).toBe(
      'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    );
  });

  it('serializes extmaps correctly', () => {
    const sdp = parse(CHROME_OFFER);
    const out = serialize(sdp);
    expect(out).toContain(
      'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    );
    expect(out).toContain(
      'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    );
  });
});

// ---------------------------------------------------------------------------
// 11. createOffer / createAnswer helpers
// ---------------------------------------------------------------------------

describe('createOffer', () => {
  it('creates a valid session description', () => {
    const offer = createOffer();
    expect(offer.version).toBe(0);
    expect(offer.mediaDescriptions.length).toBeGreaterThanOrEqual(1);
  });

  it('creates audio+video by default', () => {
    const offer = createOffer();
    const types = offer.mediaDescriptions.map((m) => m.type);
    expect(types).toContain('audio');
    expect(types).toContain('video');
  });

  it('creates audio only when specified', () => {
    const offer = createOffer({ audio: true, video: false });
    expect(offer.mediaDescriptions).toHaveLength(1);
    expect(offer.mediaDescriptions[0]!.type).toBe('audio');
  });

  it('creates data channel when specified', () => {
    const offer = createOffer({ audio: false, video: false, data: true });
    expect(offer.mediaDescriptions[0]!.type).toBe('application');
    expect(offer.mediaDescriptions[0]!.sctpPort).toBe(5000);
  });

  it('has BUNDLE group covering all mids', () => {
    const offer = createOffer({ audio: true, video: true });
    expect(offer.groups[0]!.semantic).toBe('BUNDLE');
    expect(offer.groups[0]!.mids).toContain('0');
    expect(offer.groups[0]!.mids).toContain('1');
  });

  it('serializes and re-parses cleanly', () => {
    const offer = createOffer();
    const out = serialize(offer);
    const reparsed = parse(out);
    expect(reparsed.mediaDescriptions).toHaveLength(
      offer.mediaDescriptions.length,
    );
  });
});

describe('createAnswer', () => {
  it('creates an answer from an offer', () => {
    const offer = createOffer();
    const answer = createAnswer(offer);
    expect(answer.mediaDescriptions).toHaveLength(
      offer.mediaDescriptions.length,
    );
  });

  it('flips actpass → passive', () => {
    const offer = createOffer();
    // All offer media sections have setup:actpass
    const answer = createAnswer(offer);
    for (const m of answer.mediaDescriptions) {
      expect(m.setup).toBe('passive');
    }
  });

  it('flips sendonly → recvonly', () => {
    const offer = createOffer();
    offer.mediaDescriptions[0]!.direction = 'sendonly';
    const answer = createAnswer(offer);
    expect(answer.mediaDescriptions[0]!.direction).toBe('recvonly');
  });

  it('flips recvonly → sendonly', () => {
    const offer = createOffer();
    offer.mediaDescriptions[0]!.direction = 'recvonly';
    const answer = createAnswer(offer);
    expect(answer.mediaDescriptions[0]!.direction).toBe('sendonly');
  });
});

// ---------------------------------------------------------------------------
// 12. end-of-candidates
// ---------------------------------------------------------------------------

describe('end-of-candidates', () => {
  it('parses end-of-candidates attribute', () => {
    const sdpStr = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=end-of-candidates
`;
    const sdp = parse(sdpStr);
    expect(sdp.mediaDescriptions[0]!.endOfCandidates).toBe(true);
  });

  it('serializes end-of-candidates', () => {
    const sdp = parse(`v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=end-of-candidates
`);
    const out = serialize(sdp);
    expect(out).toContain('a=end-of-candidates');
  });
});

// ---------------------------------------------------------------------------
// 13. ice-gathering-state
// ---------------------------------------------------------------------------

describe('ice-gathering-state', () => {
  it('parses ice-gathering-state', () => {
    const sdpStr = `v=0
o=- 1 1 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=ice-gathering-state:complete
`;
    const sdp = parse(sdpStr);
    expect(sdp.mediaDescriptions[0]!.iceGatheringState).toBe('complete');
  });
});
