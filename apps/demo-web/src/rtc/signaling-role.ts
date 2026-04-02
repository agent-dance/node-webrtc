import type { SignalingRole } from '../scenarios/types.js';

const ROLE_RANK: Record<SignalingRole, number> = {
  answerer: 0,
  auto: 1,
  offerer: 2,
};

export function parseSignalingRole(
  raw: string | undefined,
  fallback: SignalingRole,
): SignalingRole {
  if (raw === 'offerer' || raw === 'answerer' || raw === 'auto') {
    return raw;
  }
  return fallback;
}

export function shouldInitiateConnection(
  localRole: SignalingRole,
  localPeerId: string,
  remoteRole: SignalingRole,
  remotePeerId: string,
): { initiate: boolean; reason: string } {
  const localRank = ROLE_RANK[localRole];
  const remoteRank = ROLE_RANK[remoteRole];

  if (localRank !== remoteRank) {
    return {
      initiate: localRank > remoteRank,
      reason: `rank(${localRole}=${localRank}) vs rank(${remoteRole}=${remoteRank})`,
    };
  }

  const comparison = localPeerId.localeCompare(remotePeerId);
  return {
    initiate: comparison < 0,
    reason: `equal-rank tie break by peerId (${localPeerId} ${comparison < 0 ? '<' : '>'} ${remotePeerId})`,
  };
}
