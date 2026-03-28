# @agentdance/node-webrtc-srtp

RFC 3711 SRTP / SRTCP for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Profiles: AES-128-CM-HMAC-SHA1-80, AES-128-CM-HMAC-SHA1-32, AES-128-GCM
- RFC-verified key derivation (§4.3 test vectors)
- 64-bit sliding replay window; ROC rollover counter
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-srtp
```

## Usage

```typescript
import { createSrtpContext, srtpProtect, srtpUnprotect, ProtectionProfile } from '@agentdance/node-webrtc-srtp';

const ctx = createSrtpContext(ProtectionProfile.AES_128_CM_HMAC_SHA1_80, keyingMaterial);
const protected_  = srtpProtect(ctx, rtpPacket);
const unprotected = srtpUnprotect(ctx, protected_);
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
