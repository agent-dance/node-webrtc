import * as crypto from 'node:crypto';
import type { CandidateType, IceCandidate, TransportProtocol } from './types.js';

// ---------------------------------------------------------------------------
// RFC 8445 Section 5.1.2.1 – Candidate priority
// priority = (2^24) * type_pref + (2^8) * local_pref + (256 - component)
// type_pref: host=126, srflx=100, prflx=110, relay=0
// ---------------------------------------------------------------------------

const TYPE_PREFERENCES: Record<CandidateType, number> = {
  host: 126,
  prflx: 110,
  srflx: 100,
  relay: 0,
};

export function computePriority(
  type: CandidateType,
  localPref: number,
  component: number,
): number {
  const typePref = TYPE_PREFERENCES[type];
  return ((1 << 24) * typePref + (1 << 8) * localPref + (256 - component)) >>> 0;
}

// ---------------------------------------------------------------------------
// RFC 8445 Section 5.1.1 – Candidate foundation
// Foundation is a string that groups candidates that have the same type,
// base address, protocol and STUN/TURN server.
// ---------------------------------------------------------------------------

export function computeFoundation(
  type: CandidateType,
  baseAddress: string,
  protocol: TransportProtocol,
): string {
  const input = `${type}:${baseAddress}:${protocol}`;
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// RFC 8445 Section 6.1.2.3 – Candidate pair priority
// priority = 2^32 * min(G,D) + 2*max(G,D) + (G>D ? 1 : 0)
// ---------------------------------------------------------------------------

export function computePairPriority(
  controlling: IceCandidate,
  controlled: IceCandidate,
): bigint {
  const g = BigInt(controlling.priority >>> 0);
  const d = BigInt(controlled.priority >>> 0);
  const minVal = g < d ? g : d;
  const maxVal = g > d ? g : d;
  const gtFlag = g > d ? 1n : 0n;
  return (1n << 32n) * minVal + 2n * maxVal + gtFlag;
}

// ---------------------------------------------------------------------------
// Parse candidate from SDP attribute value string
// a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [...]
// ---------------------------------------------------------------------------

export function parseCandidateAttribute(value: string): IceCandidate {
  const parts = value.trim().split(/\s+/);

  if (parts.length < 8) {
    throw new Error(`Invalid candidate attribute: ${value}`);
  }

  const foundation = parts[0]!;
  const component = parseInt(parts[1]!, 10) as 1 | 2;
  const transport = parts[2]!.toLowerCase() as TransportProtocol;
  const priority = parseInt(parts[3]!, 10);
  const address = parts[4]!;
  const port = parseInt(parts[5]!, 10);
  // parts[6] should be 'typ'
  const type = parts[7]! as CandidateType;

  const candidate: IceCandidate = {
    foundation,
    component,
    transport,
    priority,
    address,
    port,
    type,
  };

  // Parse optional extension attributes
  let i = 8;
  while (i < parts.length - 1) {
    const key = parts[i]!;
    const val = parts[i + 1]!;
    switch (key) {
      case 'raddr':
        candidate.relatedAddress = val;
        break;
      case 'rport':
        candidate.relatedPort = parseInt(val, 10);
        break;
      case 'tcptype':
        candidate.tcpType = val as 'active' | 'passive' | 'so';
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
    }
    i += 2;
  }

  return candidate;
}

// ---------------------------------------------------------------------------
// Serialize candidate to SDP attribute value
// ---------------------------------------------------------------------------

export function serializeCandidateAttribute(candidate: IceCandidate): string {
  let s =
    `${candidate.foundation} ${candidate.component} ${candidate.transport} ` +
    `${candidate.priority} ${candidate.address} ${candidate.port} typ ${candidate.type}`;

  if (candidate.relatedAddress !== undefined) {
    s += ` raddr ${candidate.relatedAddress}`;
  }
  if (candidate.relatedPort !== undefined) {
    s += ` rport ${candidate.relatedPort}`;
  }
  if (candidate.tcpType !== undefined) {
    s += ` tcptype ${candidate.tcpType}`;
  }
  if (candidate.generation !== undefined) {
    s += ` generation ${candidate.generation}`;
  }
  if (candidate.ufrag !== undefined) {
    s += ` ufrag ${candidate.ufrag}`;
  }
  if (candidate.networkId !== undefined) {
    s += ` network-id ${candidate.networkId}`;
  }

  return s;
}

// ---------------------------------------------------------------------------
// Generate random ICE ufrag and password
// ---------------------------------------------------------------------------

const ICE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function randomIceString(length: number): string {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ICE_CHARS[bytes[i]! % ICE_CHARS.length];
  }
  return result;
}

// 4 chars minimum per RFC 5245 §15.4
export function generateUfrag(): string {
  return randomIceString(4);
}

// 22 chars minimum per RFC 5245 §15.4
export function generatePassword(): string {
  return randomIceString(22);
}
