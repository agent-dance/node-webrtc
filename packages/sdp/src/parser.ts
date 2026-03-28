import type {
  SessionDescription,
  Origin,
  Timing,
  Group,
  MediaDescription,
  Connection,
  Bandwidth,
  RtpMap,
  Fmtp,
  RtcpFb,
  IceCandidate,
  Fingerprint,
  Direction,
  Ssrc,
  SsrcGroup,
  Extmap,
  RtcpAttr,
} from './types.js';

// ---------------------------------------------------------------------------
// Candidate line parser (exported for standalone use)
// ---------------------------------------------------------------------------

/**
 * Parse the *value* of a candidate attribute (the part after "a=candidate:" or
 * a bare "candidate:" prefix is also accepted for convenience).
 */
export function parseCandidate(line: string): IceCandidate {
  // Strip optional "a=candidate:" or "candidate:" prefix
  const value = line
    .replace(/^a=candidate:/i, '')
    .replace(/^candidate:/i, '');

  const parts = value.trim().split(/\s+/);
  if (parts.length < 8) {
    throw new Error(`Invalid candidate line: ${line}`);
  }

  const foundation = parts[0]!;
  const component = parseInt(parts[1]!, 10);
  const transport = parts[2]!;
  const priority = parseInt(parts[3]!, 10);
  const address = parts[4]!;
  const port = parseInt(parts[5]!, 10);
  // parts[6] === 'typ'
  const type = parts[7]!;

  const candidate: IceCandidate = {
    foundation,
    component,
    transport,
    priority,
    address,
    port,
    type,
  };

  // Parse extension fields that come in key/value pairs after the type
  let i = 8;
  while (i < parts.length - 1) {
    const key = parts[i]!;
    const val = parts[i + 1]!;
    i += 2;

    switch (key.toLowerCase()) {
      case 'raddr':
        candidate.relatedAddress = val;
        break;
      case 'rport':
        candidate.relatedPort = parseInt(val, 10);
        break;
      case 'tcptype':
        candidate.tcpType = val;
        break;
      case 'generation':
        candidate.generation = parseInt(val, 10);
        break;
      case 'ufrag':
        candidate.ufrag = val;
        break;
      case 'network-id':
        candidate.networkId = parseInt(val, 10);
        break;
      case 'network-cost':
        candidate.networkCost = parseInt(val, 10);
        break;
      default: {
        if (!candidate.extensions) candidate.extensions = {};
        candidate.extensions[key] = val;
      }
    }
  }

  return candidate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrigin(value: string): Origin {
  const parts = value.split(' ');
  if (parts.length < 6) throw new Error(`Invalid origin line: ${value}`);
  return {
    username: parts[0]!,
    sessionId: parts[1]!,
    sessionVersion: parseInt(parts[2]!, 10),
    networkType: parts[3]!,
    addressType: parts[4]!,
    unicastAddress: parts[5]!,
  };
}

function parseTiming(value: string): Timing {
  const parts = value.split(' ');
  return {
    startTime: parseInt(parts[0] ?? '0', 10),
    stopTime: parseInt(parts[1] ?? '0', 10),
  };
}

function parseConnection(value: string): Connection {
  const parts = value.split(' ');
  return {
    networkType: parts[0]!,
    addressType: parts[1]!,
    address: parts[2]!,
  };
}

function parseBandwidth(value: string): Bandwidth {
  const idx = value.indexOf(':');
  return {
    type: value.substring(0, idx),
    bandwidth: parseInt(value.substring(idx + 1), 10),
  };
}

function parseRtpMap(value: string): RtpMap {
  // e.g.  "111 opus/48000/2"
  const spaceIdx = value.indexOf(' ');
  const payloadType = parseInt(value.substring(0, spaceIdx), 10);
  const rest = value.substring(spaceIdx + 1);
  const slashParts = rest.split('/');
  const encoding = slashParts[0]!;
  const clockRate = parseInt(slashParts[1] ?? '0', 10);
  const encodingParams = slashParts[2];
  const result: RtpMap = { payloadType, encoding, clockRate };
  if (encodingParams !== undefined) result.encodingParams = encodingParams;
  return result;
}

function parseFmtp(value: string): Fmtp {
  const spaceIdx = value.indexOf(' ');
  const payloadType = parseInt(value.substring(0, spaceIdx), 10);
  const parameters = value.substring(spaceIdx + 1);
  return { payloadType, parameters };
}

function parseRtcpFb(value: string): RtcpFb {
  // e.g. "111 transport-cc" or "96 ccm fir"
  const parts = value.split(' ');
  const payloadType = parseInt(parts[0]!, 10);
  const type = parts[1]!;
  const parameter = parts.length > 2 ? parts.slice(2).join(' ') : undefined;
  const result: RtcpFb = { payloadType, type };
  if (parameter !== undefined) result.parameter = parameter;
  return result;
}

function parseSsrc(value: string): Ssrc {
  // e.g.  "1234567890 cname:some-cname"  or  "1234567890 msid:stream1 audio1"
  const spaceIdx = value.indexOf(' ');
  const id = parseInt(value.substring(0, spaceIdx), 10);
  const rest = value.substring(spaceIdx + 1);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    return { id, attribute: rest };
  }
  const attribute = rest.substring(0, colonIdx);
  const val = rest.substring(colonIdx + 1);
  const result: Ssrc = { id, attribute };
  if (val !== '') result.value = val;
  return result;
}

function parseSsrcGroup(value: string): SsrcGroup {
  // e.g. "FID 2222222222 3333333333"
  const parts = value.split(' ');
  const semantic = parts[0]!;
  const ssrcIds = parts.slice(1).map((s) => parseInt(s, 10));
  return { semantic, ssrcIds };
}

function parseExtmap(value: string): Extmap {
  // e.g. "1 urn:ietf:params:rtp-hdrext:ssrc-audio-level"
  //      "2/sendrecv urn:... some attributes"
  const parts = value.split(' ');
  const idPart = parts[0]!;
  const uri = parts[1]!;
  const attributes = parts.length > 2 ? parts.slice(2).join(' ') : undefined;

  let id: number;
  let direction: string | undefined;

  const slashIdx = idPart.indexOf('/');
  if (slashIdx !== -1) {
    id = parseInt(idPart.substring(0, slashIdx), 10);
    direction = idPart.substring(slashIdx + 1);
  } else {
    id = parseInt(idPart, 10);
  }

  const result: Extmap = { id, uri };
  if (direction !== undefined) result.direction = direction;
  if (attributes !== undefined) result.attributes = attributes;
  return result;
}

function parseRtcpAttr(value: string): RtcpAttr {
  // e.g.  "9 IN IP4 0.0.0.0"  or just "9"
  const parts = value.split(' ');
  const port = parseInt(parts[0]!, 10);
  const result: RtcpAttr = { port };
  if (parts.length >= 4) {
    result.networkType = parts[1]!;
    result.addressType = parts[2]!;
    result.address = parts[3]!;
  }
  return result;
}

function parseGroup(value: string): Group {
  // e.g. "BUNDLE 0 1"
  const parts = value.split(' ');
  return {
    semantic: parts[0]!,
    mids: parts.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parse(sdp: string): SessionDescription {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Defaults / placeholders
  let version = 0;
  let origin: Origin = {
    username: '-',
    sessionId: '0',
    sessionVersion: 0,
    networkType: 'IN',
    addressType: 'IP4',
    unicastAddress: '127.0.0.1',
  };
  let sessionName = '-';
  let timing: Timing = { startTime: 0, stopTime: 0 };
  const groups: Group[] = [];
  let msidSemantic: string | undefined;
  const mediaDescriptions: MediaDescription[] = [];

  let currentMedia: MediaDescription | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const typeChar = line[0];
    if (line[1] !== '=') continue; // malformed — skip
    const value = line.substring(2);

    if (currentMedia === null) {
      // Session-level parsing
      switch (typeChar) {
        case 'v':
          version = parseInt(value, 10);
          break;
        case 'o':
          origin = parseOrigin(value);
          break;
        case 's':
          sessionName = value;
          break;
        case 't':
          timing = parseTiming(value);
          break;
        case 'c':
          // session-level connection — we'll attach to first media or ignore
          break;
        case 'a': {
          const eqIdx = value.indexOf(':');
          const attrName = eqIdx === -1 ? value : value.substring(0, eqIdx);
          const attrVal = eqIdx === -1 ? '' : value.substring(eqIdx + 1);

          switch (attrName) {
            case 'group':
              groups.push(parseGroup(attrVal));
              break;
            case 'msid-semantic':
              msidSemantic = attrVal.trim();
              break;
            // extmap-allow-mixed is a session-level attr we just ignore for the model
          }
          break;
        }
        case 'm': {
          // Start a new media section
          // "audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126"
          const mParts = value.split(' ');
          const mType = mParts[0]!;
          const mPort = parseInt(mParts[1]!, 10);
          const mProtocol = mParts[2]!;
          const payloadTypes = mParts
            .slice(3)
            .map((s) => parseInt(s, 10))
            .filter((n) => !isNaN(n));

          currentMedia = {
            type: mType,
            port: mPort,
            protocol: mProtocol,
            payloadTypes,
            rtpMaps: [],
            fmtps: [],
            rtcpFbs: [],
            candidates: [],
            ssrcs: [],
            ssrcGroups: [],
            extmaps: [],
          };
          mediaDescriptions.push(currentMedia);
          break;
        }
      }
    } else {
      // Media-level parsing
      switch (typeChar) {
        case 'm': {
          // Start another media section
          const mParts = value.split(' ');
          const mType = mParts[0]!;
          const mPort = parseInt(mParts[1]!, 10);
          const mProtocol = mParts[2]!;
          const payloadTypes = mParts
            .slice(3)
            .map((s) => parseInt(s, 10))
            .filter((n) => !isNaN(n));

          currentMedia = {
            type: mType,
            port: mPort,
            protocol: mProtocol,
            payloadTypes,
            rtpMaps: [],
            fmtps: [],
            rtcpFbs: [],
            candidates: [],
            ssrcs: [],
            ssrcGroups: [],
            extmaps: [],
          };
          mediaDescriptions.push(currentMedia);
          break;
        }
        case 'c':
          currentMedia.connection = parseConnection(value);
          break;
        case 'b':
          currentMedia.bandwidth = parseBandwidth(value);
          break;
        case 'a': {
          const eqIdx = value.indexOf(':');
          const attrName = eqIdx === -1 ? value : value.substring(0, eqIdx);
          const attrVal = eqIdx === -1 ? '' : value.substring(eqIdx + 1);

          switch (attrName) {
            case 'rtpmap':
              currentMedia.rtpMaps.push(parseRtpMap(attrVal));
              break;
            case 'fmtp':
              currentMedia.fmtps.push(parseFmtp(attrVal));
              break;
            case 'rtcp-fb':
              currentMedia.rtcpFbs.push(parseRtcpFb(attrVal));
              break;
            case 'candidate':
              currentMedia.candidates.push(parseCandidate(attrVal));
              break;
            case 'ice-ufrag':
              currentMedia.iceUfrag = attrVal;
              break;
            case 'ice-pwd':
              currentMedia.icePwd = attrVal;
              break;
            case 'ice-options':
              currentMedia.iceOptions = attrVal;
              break;
            case 'ice-gathering-state':
              currentMedia.iceGatheringState = attrVal;
              break;
            case 'fingerprint': {
              const spaceIdx = attrVal.indexOf(' ');
              currentMedia.fingerprint = {
                algorithm: attrVal.substring(0, spaceIdx),
                value: attrVal.substring(spaceIdx + 1),
              } satisfies Fingerprint;
              break;
            }
            case 'setup':
              currentMedia.setup = attrVal;
              break;
            case 'mid':
              currentMedia.mid = attrVal;
              break;
            case 'sendrecv':
            case 'sendonly':
            case 'recvonly':
            case 'inactive':
              currentMedia.direction = attrName as Direction;
              break;
            case 'rtcp':
              currentMedia.rtcp = parseRtcpAttr(attrVal);
              break;
            case 'rtcp-mux':
              currentMedia.rtcpMux = true;
              break;
            case 'rtcp-rsize':
              currentMedia.rtcpRsize = true;
              break;
            case 'ssrc':
              currentMedia.ssrcs.push(parseSsrc(attrVal));
              break;
            case 'ssrc-group':
              currentMedia.ssrcGroups.push(parseSsrcGroup(attrVal));
              break;
            case 'msid':
              currentMedia.msid = attrVal;
              break;
            case 'extmap':
              currentMedia.extmaps.push(parseExtmap(attrVal));
              break;
            case 'sctp-port':
              currentMedia.sctpPort = parseInt(attrVal, 10);
              break;
            case 'max-message-size':
              currentMedia.maxMessageSize = parseInt(attrVal, 10);
              break;
            case 'end-of-candidates':
              currentMedia.endOfCandidates = true;
              break;
            // group / msid-semantic can also appear at media level in some implementations
            case 'group':
              // media-level group — ignore for now (unusual)
              break;
          }
          break;
        }
      }
    }
  }

  const result: SessionDescription = {
    version,
    origin,
    sessionName,
    timing,
    groups,
    mediaDescriptions,
  };
  if (msidSemantic !== undefined) result.msidSemantic = msidSemantic;
  return result;
}
