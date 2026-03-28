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

  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 1 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${localParams.usernameFragment}`,
    `a=ice-pwd:${localParams.password}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${certificate.fingerprint.value}`,
    `a=setup:${localSetup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];

  return lines.join('\r\n') + '\r\n';
}
