# @agentdance/node-webrtc-dtls

RFC 6347 DTLS 1.2 transport for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Full client + server handshake state machine
- ECDHE P-256, AES-128-GCM
- Self-signed certificate via pure ASN.1/DER builder (no OpenSSL)
- RFC 5763 §5 role negotiation (actpass / active / passive)
- 60-byte SRTP keying material export
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-dtls
```

## Usage

```typescript
import { DtlsTransport } from '@agentdance/node-webrtc-dtls';

const dtls = new DtlsTransport(iceTransport, {
  role: 'client',  // or 'server'
  remoteFingerprint: { algorithm: 'sha-256', value: '…' },
});
await dtls.start();
dtls.on('connected', () => {
  const keys = dtls.getSrtpKeyingMaterial();
});
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
