/**
 * Parse ICE/DTLS/SCTP parameters from SDP strings
 */

export interface ParsedIceParameters {
  usernameFragment: string;
  password: string;
}

export function parseIceParameters(sdp: string): ParsedIceParameters | null {
  const ufragMatch = sdp.match(/a=ice-ufrag:(\S+)/);
  const pwdMatch = sdp.match(/a=ice-pwd:(\S+)/);
  if (!ufragMatch || !pwdMatch) return null;
  return {
    usernameFragment: ufragMatch[1]!,
    password: pwdMatch[1]!,
  };
}

export function parseDtlsFingerprint(sdp: string): { algorithm: string; value: string } | null {
  const match = sdp.match(/a=fingerprint:(\S+)\s+(\S+)/);
  if (!match) return null;
  return { algorithm: match[1]!, value: match[2]! };
}

export function parseSctpPort(sdp: string): number | null {
  const match = sdp.match(/a=sctp-port:(\d+)/);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

export function parseCandidatesFromSdp(sdp: string): import('@agentdance/node-webrtc-ice').IceCandidate[] {
  const candidates: import('@agentdance/node-webrtc-ice').IceCandidate[] = [];
  const lines = sdp.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^a=candidate:(.+)$/);
    if (match) {
      const candidate = parseCandidateLine(match[1]!);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function parseCandidateLine(value: string): import('@agentdance/node-webrtc-ice').IceCandidate | null {
  const parts = value.split(' ');
  if (parts.length < 8) return null;
  const [foundation, componentStr, transport, priorityStr, address, portStr, , type, ...rest] = parts;
  const candidate: import('@agentdance/node-webrtc-ice').IceCandidate = {
    foundation: foundation ?? '',
    component: (componentStr === '1' ? 1 : 2) as 1 | 2,
    transport: (transport?.toLowerCase() ?? 'udp') as 'udp' | 'tcp',
    priority: parseInt(priorityStr ?? '0', 10),
    address: address ?? '',
    port: parseInt(portStr ?? '0', 10),
    type: (type ?? 'host') as 'host' | 'srflx' | 'relay' | 'prflx',
  };
  // Parse extensions
  for (let i = 0; i < rest.length - 1; i += 2) {
    const key = rest[i];
    const val = rest[i + 1];
    if (key === 'raddr' && val !== undefined) candidate.relatedAddress = val;
    else if (key === 'rport' && val !== undefined) candidate.relatedPort = parseInt(val, 10);
    else if (key === 'generation' && val !== undefined) candidate.generation = parseInt(val, 10);
    else if (key === 'ufrag' && val !== undefined) candidate.ufrag = val;
    else if (key === 'network-id' && val !== undefined) candidate.networkId = parseInt(val, 10);
  }
  return candidate;
}
