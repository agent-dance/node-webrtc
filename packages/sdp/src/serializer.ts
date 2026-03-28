import type {
  SessionDescription,
  MediaDescription,
  IceCandidate,
  RtcpAttr,
  Extmap,
} from './types.js';

// ---------------------------------------------------------------------------
// Candidate serializer (exported for standalone use)
// ---------------------------------------------------------------------------

export function serializeCandidate(c: IceCandidate): string {
  let line =
    `${c.foundation} ${c.component} ${c.transport} ${c.priority} ` +
    `${c.address} ${c.port} typ ${c.type}`;

  if (c.relatedAddress !== undefined) line += ` raddr ${c.relatedAddress}`;
  if (c.relatedPort !== undefined) line += ` rport ${c.relatedPort}`;
  if (c.tcpType !== undefined) line += ` tcptype ${c.tcpType}`;
  if (c.generation !== undefined) line += ` generation ${c.generation}`;
  if (c.ufrag !== undefined) line += ` ufrag ${c.ufrag}`;
  if (c.networkId !== undefined) line += ` network-id ${c.networkId}`;
  if (c.networkCost !== undefined) line += ` network-cost ${c.networkCost}`;

  if (c.extensions) {
    for (const [k, v] of Object.entries(c.extensions)) {
      line += ` ${k} ${v}`;
    }
  }

  return line;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeRtcpAttr(r: RtcpAttr): string {
  if (
    r.networkType !== undefined &&
    r.addressType !== undefined &&
    r.address !== undefined
  ) {
    return `${r.port} ${r.networkType} ${r.addressType} ${r.address}`;
  }
  return `${r.port}`;
}

function serializeExtmap(e: Extmap): string {
  const idPart =
    e.direction !== undefined ? `${e.id}/${e.direction}` : `${e.id}`;
  let s = `${idPart} ${e.uri}`;
  if (e.attributes !== undefined) s += ` ${e.attributes}`;
  return s;
}

function serializeMedia(m: MediaDescription): string {
  const lines: string[] = [];

  const ptStr = m.payloadTypes.join(' ');
  lines.push(`m=${m.type} ${m.port} ${m.protocol} ${ptStr}`);

  if (m.connection) {
    lines.push(
      `c=${m.connection.networkType} ${m.connection.addressType} ${m.connection.address}`,
    );
  }

  if (m.bandwidth) {
    lines.push(`b=${m.bandwidth.type}:${m.bandwidth.bandwidth}`);
  }

  if (m.rtcp) {
    lines.push(`a=rtcp:${serializeRtcpAttr(m.rtcp)}`);
  }

  if (m.iceUfrag !== undefined) lines.push(`a=ice-ufrag:${m.iceUfrag}`);
  if (m.icePwd !== undefined) lines.push(`a=ice-pwd:${m.icePwd}`);
  if (m.iceOptions !== undefined) lines.push(`a=ice-options:${m.iceOptions}`);
  if (m.iceGatheringState !== undefined)
    lines.push(`a=ice-gathering-state:${m.iceGatheringState}`);

  if (m.fingerprint) {
    lines.push(
      `a=fingerprint:${m.fingerprint.algorithm} ${m.fingerprint.value}`,
    );
  }

  if (m.setup !== undefined) lines.push(`a=setup:${m.setup}`);
  if (m.mid !== undefined) lines.push(`a=mid:${m.mid}`);

  for (const e of m.extmaps) {
    lines.push(`a=extmap:${serializeExtmap(e)}`);
  }

  if (m.direction !== undefined) lines.push(`a=${m.direction}`);
  if (m.msid !== undefined) lines.push(`a=msid:${m.msid}`);
  if (m.rtcpMux === true) lines.push('a=rtcp-mux');
  if (m.rtcpRsize === true) lines.push('a=rtcp-rsize');

  for (const rm of m.rtpMaps) {
    const encStr =
      rm.encodingParams !== undefined
        ? `${rm.encoding}/${rm.clockRate}/${rm.encodingParams}`
        : `${rm.encoding}/${rm.clockRate}`;
    lines.push(`a=rtpmap:${rm.payloadType} ${encStr}`);

    // Emit rtcp-fb for this payload type
    for (const fb of m.rtcpFbs.filter(
      (f) => f.payloadType === rm.payloadType,
    )) {
      const fbLine =
        fb.parameter !== undefined
          ? `a=rtcp-fb:${fb.payloadType} ${fb.type} ${fb.parameter}`
          : `a=rtcp-fb:${fb.payloadType} ${fb.type}`;
      lines.push(fbLine);
    }

    // Emit fmtp for this payload type
    for (const fmtp of m.fmtps.filter(
      (f) => f.payloadType === rm.payloadType,
    )) {
      lines.push(`a=fmtp:${fmtp.payloadType} ${fmtp.parameters}`);
    }
  }

  // Emit any rtcp-fb / fmtp entries whose payloadType is not in rtpMaps
  // (shouldn't normally happen, but be safe)
  const mappedPts = new Set(m.rtpMaps.map((r) => r.payloadType));

  for (const fb of m.rtcpFbs.filter((f) => !mappedPts.has(f.payloadType))) {
    const fbLine =
      fb.parameter !== undefined
        ? `a=rtcp-fb:${fb.payloadType} ${fb.type} ${fb.parameter}`
        : `a=rtcp-fb:${fb.payloadType} ${fb.type}`;
    lines.push(fbLine);
  }

  for (const fmtp of m.fmtps.filter((f) => !mappedPts.has(f.payloadType))) {
    lines.push(`a=fmtp:${fmtp.payloadType} ${fmtp.parameters}`);
  }

  for (const sg of m.ssrcGroups) {
    lines.push(`a=ssrc-group:${sg.semantic} ${sg.ssrcIds.join(' ')}`);
  }

  for (const ssrc of m.ssrcs) {
    if (ssrc.value !== undefined) {
      lines.push(`a=ssrc:${ssrc.id} ${ssrc.attribute}:${ssrc.value}`);
    } else {
      lines.push(`a=ssrc:${ssrc.id} ${ssrc.attribute}`);
    }
  }

  for (const cand of m.candidates) {
    lines.push(`a=candidate:${serializeCandidate(cand)}`);
  }

  if (m.sctpPort !== undefined) lines.push(`a=sctp-port:${m.sctpPort}`);
  if (m.maxMessageSize !== undefined)
    lines.push(`a=max-message-size:${m.maxMessageSize}`);
  if (m.endOfCandidates === true) lines.push('a=end-of-candidates');

  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Main serializer
// ---------------------------------------------------------------------------

export function serialize(desc: SessionDescription): string {
  const lines: string[] = [];

  lines.push(`v=${desc.version}`);
  lines.push(
    `o=${desc.origin.username} ${desc.origin.sessionId} ${desc.origin.sessionVersion} ` +
      `${desc.origin.networkType} ${desc.origin.addressType} ${desc.origin.unicastAddress}`,
  );
  lines.push(`s=${desc.sessionName}`);
  lines.push(`t=${desc.timing.startTime} ${desc.timing.stopTime}`);

  for (const g of desc.groups) {
    lines.push(`a=group:${g.semantic} ${g.mids.join(' ')}`);
  }

  if (desc.msidSemantic !== undefined) {
    lines.push(`a=msid-semantic: ${desc.msidSemantic}`);
  }

  for (const m of desc.mediaDescriptions) {
    lines.push(serializeMedia(m));
  }

  // RFC 8866: SDP must end with CRLF
  return lines.join('\r\n') + '\r\n';
}
