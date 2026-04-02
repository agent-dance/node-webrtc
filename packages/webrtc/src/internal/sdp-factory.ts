/**
 * SDP generation for offer/answer
 */
import type { IceAgent } from '@agentdance/node-webrtc-ice';
import type { DtlsCertificate } from '@agentdance/node-webrtc-dtls';
import type { RTCConfiguration } from '../types.js';
import crypto from 'node:crypto';

export async function generateSdpOffer(
  iceAgent: IceAgent,
  config: Required<RTCConfiguration>,
  certificate: DtlsCertificate,
): Promise<string> {
  const localParams = iceAgent.localParameters;

  const sessionId = crypto.randomBytes(8).readBigUInt64BE(0).toString();

  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 1 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    // Data channel media section
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${localParams.usernameFragment}`,
    `a=ice-pwd:${localParams.password}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${certificate.fingerprint.value}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];

  return lines.join('\r\n') + '\r\n';
}

export async function generateSdpAnswer(
  iceAgent: IceAgent,
  remoteSdp: string,
  config: Required<RTCConfiguration>,
  certificate: DtlsCertificate,
): Promise<string> {
  const localParams = iceAgent.localParameters;

  // Determine DTLS setup role per RFC 5763 §5:
  //   remote=actpass → we pick active (we become DTLS client)
  //   remote=active  → we must be passive (we become DTLS server)
  //   remote=passive → we must be active  (we become DTLS client)
  const remoteSetup = remoteSdp.match(/a=setup:(\w+)/)?.[1] ?? 'actpass';
  const localSetup = remoteSetup === 'actpass' ? 'active' :
                     remoteSetup === 'active'  ? 'passive' : 'active';

  const sessionId = Math.floor(Math.random() * 1e15).toString();

  // RFC 3264 §6: The answer MUST contain the same number of m-lines as the
  // offer, in the same order.  For m-lines we don't support, set port=0.
  // We parse the offer's m-lines and mirror them, only filling in our ICE/DTLS
  // parameters for the m=application (datachannel) section.
  const offerLines = remoteSdp.split(/\r?\n/);
  const mLineSections: { mLine: string; mid: string | null; isApplication: boolean }[] = [];
  let currentMid: string | null = null;
  let currentIsApp = false;

  for (const line of offerLines) {
    if (line.startsWith('m=')) {
      if (mLineSections.length > 0 || currentIsApp) {
        // flush previous if it was started
      }
      currentIsApp = line.startsWith('m=application');
      currentMid = null;
    }
    if (line.startsWith('a=mid:')) {
      currentMid = line.slice(6).trim();
    }
    // When we hit the next m= or end, push the previous section
    if (line.startsWith('m=') && mLineSections.length >= 0) {
      mLineSections.push({
        mLine: line,
        mid: currentMid, // will be updated below
        isApplication: currentIsApp,
      });
    }
  }

  // Second pass: properly associate mids with their m-lines
  const sections: { mLine: string; mid: string | null; isApplication: boolean }[] = [];
  let currentSection: { mLine: string; mid: string | null; isApplication: boolean } | null = null;
  for (const line of offerLines) {
    if (line.startsWith('m=')) {
      if (currentSection) sections.push(currentSection);
      currentSection = {
        mLine: line,
        mid: null,
        isApplication: line.startsWith('m=application'),
      };
    } else if (line.startsWith('a=mid:') && currentSection) {
      currentSection.mid = line.slice(6).trim();
    }
  }
  if (currentSection) sections.push(currentSection);

  // Fallback: if offer has no m-lines (e.g. minimal test SDP), produce a
  // single m=application section with mid=0 (original behaviour).
  if (sections.length === 0) {
    sections.push({ mLine: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', mid: '0', isApplication: true });
  }

  // Extract BUNDLE group mids from offer
  const bundleMatch = remoteSdp.match(/a=group:BUNDLE\s+(.+)/);
  const bundleMids = bundleMatch ? bundleMatch[1]!.trim() : sections.map(s => s.mid).filter(Boolean).join(' ');

  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 1 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundleMids}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
  ];

  for (const section of sections) {
    if (section.isApplication) {
      // We support this m-line — fill in our ICE/DTLS/SCTP parameters
      lines.push(
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        `a=ice-ufrag:${localParams.usernameFragment}`,
        `a=ice-pwd:${localParams.password}`,
        'a=ice-options:trickle',
        `a=fingerprint:sha-256 ${certificate.fingerprint.value}`,
        `a=setup:${localSetup}`,
        `a=mid:${section.mid ?? '0'}`,
        'a=sctp-port:5000',
        'a=max-message-size:262144',
      );
    } else {
      // Unsupported m-line — reject with port=0 (RFC 3264 §6)
      // Replace port in the m-line with 0
      const parts = section.mLine.split(' ');
      parts[1] = '0'; // port = 0 means rejected
      lines.push(
        parts.join(' '),
        'c=IN IP4 0.0.0.0',
        `a=mid:${section.mid ?? '0'}`,
      );
    }
  }

  return lines.join('\r\n') + '\r\n';
}
