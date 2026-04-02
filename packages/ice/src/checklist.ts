import type {
  CandidatePair,
  IceCandidate,
  IceRole,
} from './types.js';
import { CandidatePairState } from './types.js';
import { computePairPriority } from './candidate.js';

// ---------------------------------------------------------------------------
// Pair ID generation
// ---------------------------------------------------------------------------

export function makePairId(local: IceCandidate, remote: IceCandidate): string {
  return `${local.foundation}:${local.port}|${remote.foundation}:${remote.port}`;
}

// ---------------------------------------------------------------------------
// Form candidate pairs from local × remote candidates (same component)
// sorted descending by priority
// ---------------------------------------------------------------------------

export function formCandidatePairs(
  localCandidates: IceCandidate[],
  remoteCandidates: IceCandidate[],
  role: IceRole,
): CandidatePair[] {
  const pairs: CandidatePair[] = [];

  for (const local of localCandidates) {
    for (const remote of remoteCandidates) {
      if (local.component !== remote.component) continue;
      // ts-rtc uses UDP-only transport; skip TCP remote candidates
      if (remote.transport !== 'udp') continue;
      if (local.transport !== 'udp') continue;
      // ts-rtc binds a udp4 socket; IPv6 candidates will silently fail — skip them
      if (remote.address.includes(':')) continue;

      // Skip loopback↔non-loopback pairs — they can never succeed across hosts
      const localIsLoopback = local.address === '127.0.0.1' || local.address === '::1';
      const remoteIsLoopback = remote.address === '127.0.0.1' || remote.address === '::1';
      if (localIsLoopback !== remoteIsLoopback) continue;

      const controlling = role === 'controlling' ? local : remote;
      const controlled = role === 'controlling' ? remote : local;
      const priority = computePairPriority(controlling, controlled);

      const pair: CandidatePair = {
        id: makePairId(local, remote),
        local,
        remote,
        state: CandidatePairState.Frozen,
        priority,
        nominated: false,
        valid: false,
        nominateOnSuccess: false,
        retransmitCount: 0,
      };

      pairs.push(pair);
    }
  }

  // Sort by priority descending
  pairs.sort((a, b) => {
    if (b.priority > a.priority) return 1;
    if (b.priority < a.priority) return -1;
    return 0;
  });

  return pairs;
}

// ---------------------------------------------------------------------------
// Unfreeze the highest priority pair per component (RFC 8445 §6.1.2.6)
// ---------------------------------------------------------------------------

export function unfreezeInitialPairs(pairs: CandidatePair[]): void {
  const seenComponents = new Set<number>();
  for (const pair of pairs) {
    if (
      !seenComponents.has(pair.local.component) &&
      pair.state === CandidatePairState.Frozen
    ) {
      pair.state = CandidatePairState.Waiting;
      seenComponents.add(pair.local.component);
    }
  }
}

// ---------------------------------------------------------------------------
// Find pair by address/port tuples
// ---------------------------------------------------------------------------

export function findPairByAddresses(
  pairs: CandidatePair[],
  localAddr: string,
  localPort: number,
  remoteAddr: string,
  remotePort: number,
): CandidatePair | undefined {
  return pairs.find(
    (p) =>
      p.local.address === localAddr &&
      p.local.port === localPort &&
      p.remote.address === remoteAddr &&
      p.remote.port === remotePort,
  );
}

// ---------------------------------------------------------------------------
// Get or create a candidate pair
// ---------------------------------------------------------------------------

export function getOrCreatePair(
  pairs: CandidatePair[],
  local: IceCandidate,
  remote: IceCandidate,
  role: IceRole,
): { pair: CandidatePair; isNew: boolean } {
  const existing = pairs.find(
    (p) =>
      p.local.address === local.address &&
      p.local.port === local.port &&
      p.remote.address === remote.address &&
      p.remote.port === remote.port,
  );
  if (existing) return { pair: existing, isNew: false };

  const controlling = role === 'controlling' ? local : remote;
  const controlled = role === 'controlling' ? remote : local;
  const priority = computePairPriority(controlling, controlled);

  const pair: CandidatePair = {
    id: makePairId(local, remote),
    local,
    remote,
    state: CandidatePairState.Waiting,
    priority,
    nominated: false,
    valid: false,
    nominateOnSuccess: false,
    retransmitCount: 0,
  };

  return { pair, isNew: true };
}

