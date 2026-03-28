import type { SessionDescription, MediaDescription } from './types.js';

let sessionIdCounter = BigInt(Date.now()) * BigInt(1000);

function nextSessionId(): string {
  sessionIdCounter += BigInt(1);
  return sessionIdCounter.toString();
}

function baseMedia(
  type: string,
  protocol: string,
  payloadTypes: number[],
): MediaDescription {
  return {
    type,
    port: 9,
    protocol,
    payloadTypes,
    rtpMaps: [],
    fmtps: [],
    rtcpFbs: [],
    candidates: [],
    ssrcs: [],
    ssrcGroups: [],
    extmaps: [],
    connection: { networkType: 'IN', addressType: 'IP4', address: '0.0.0.0' },
    rtcpMux: true,
  };
}

function audioMedia(): MediaDescription {
  const m = baseMedia('audio', 'UDP/TLS/RTP/SAVPF', [111]);
  m.rtpMaps = [{ payloadType: 111, encoding: 'opus', clockRate: 48000, encodingParams: '2' }];
  m.fmtps = [{ payloadType: 111, parameters: 'minptime=10;useinbandfec=1' }];
  m.rtcpFbs = [{ payloadType: 111, type: 'transport-cc' }];
  m.direction = 'sendrecv';
  m.mid = '0';
  return m;
}

function videoMedia(): MediaDescription {
  const m = baseMedia('video', 'UDP/TLS/RTP/SAVPF', [96, 97]);
  m.rtpMaps = [
    { payloadType: 96, encoding: 'VP8', clockRate: 90000 },
    { payloadType: 97, encoding: 'rtx', clockRate: 90000 },
  ];
  m.fmtps = [{ payloadType: 97, parameters: 'apt=96' }];
  m.rtcpFbs = [
    { payloadType: 96, type: 'goog-remb' },
    { payloadType: 96, type: 'transport-cc' },
    { payloadType: 96, type: 'ccm', parameter: 'fir' },
    { payloadType: 96, type: 'nack' },
    { payloadType: 96, type: 'nack', parameter: 'pli' },
  ];
  m.direction = 'sendrecv';
  m.rtcpRsize = true;
  m.mid = '1';
  return m;
}

function dataMedia(): MediaDescription {
  const m = baseMedia('application', 'UDP/DTLS/SCTP', [5000]);
  m.payloadTypes = [];
  // For data channels we use the "webrtc-datachannel" fmt instead of payload types
  m.sctpPort = 5000;
  m.maxMessageSize = 262144;
  m.mid = '2';
  return m;
}

export interface CreateOfferOptions {
  audio?: boolean;
  video?: boolean;
  data?: boolean;
}

export function createOffer(options: CreateOfferOptions = {}): SessionDescription {
  const { audio = true, video = true, data = false } = options;

  const mediaDescriptions: MediaDescription[] = [];
  const mids: string[] = [];

  if (audio) {
    const m = audioMedia();
    m.setup = 'actpass';
    mediaDescriptions.push(m);
    if (m.mid !== undefined) mids.push(m.mid);
  }

  if (video) {
    const m = videoMedia();
    m.setup = 'actpass';
    mediaDescriptions.push(m);
    if (m.mid !== undefined) mids.push(m.mid);
  }

  if (data) {
    const m = dataMedia();
    m.setup = 'actpass';
    mediaDescriptions.push(m);
    if (m.mid !== undefined) mids.push(m.mid);
  }

  return {
    version: 0,
    origin: {
      username: '-',
      sessionId: nextSessionId(),
      sessionVersion: 2,
      networkType: 'IN',
      addressType: 'IP4',
      unicastAddress: '127.0.0.1',
    },
    sessionName: '-',
    timing: { startTime: 0, stopTime: 0 },
    groups: mids.length > 0 ? [{ semantic: 'BUNDLE', mids }] : [],
    msidSemantic: 'WMS',
    mediaDescriptions,
  };
}

export function createAnswer(offer: SessionDescription): SessionDescription {
  const mediaDescriptions: MediaDescription[] = offer.mediaDescriptions.map(
    (offered) => {
      const flippedDirection = flipDirection(offered.direction);
      const m: MediaDescription = {
        ...offered,
        rtpMaps: [...offered.rtpMaps],
        fmtps: [...offered.fmtps],
        rtcpFbs: [...offered.rtcpFbs],
        candidates: [],
        ssrcs: [],
        ssrcGroups: [],
        extmaps: [...offered.extmaps],
        setup: offered.setup === 'actpass' ? 'passive' : 'active',
      };
      if (flippedDirection !== undefined) {
        m.direction = flippedDirection;
      } else {
        delete m.direction;
      }
      return m;
    },
  );

  return {
    version: 0,
    origin: {
      username: '-',
      sessionId: nextSessionId(),
      sessionVersion: 2,
      networkType: 'IN',
      addressType: 'IP4',
      unicastAddress: '127.0.0.1',
    },
    sessionName: '-',
    timing: { startTime: 0, stopTime: 0 },
    groups: offer.groups.map((g) => ({ ...g, mids: [...g.mids] })),
    ...(offer.msidSemantic !== undefined ? { msidSemantic: offer.msidSemantic } : {}),
    mediaDescriptions,
  };
}

function flipDirection(
  dir: SessionDescription['mediaDescriptions'][0]['direction'],
): SessionDescription['mediaDescriptions'][0]['direction'] {
  switch (dir) {
    case 'sendonly':
      return 'recvonly';
    case 'recvonly':
      return 'sendonly';
    default:
      return dir; // sendrecv / inactive / undefined stay the same
  }
}
