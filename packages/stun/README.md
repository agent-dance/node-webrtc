# @agentdance/node-webrtc-stun

RFC 5389 STUN message codec + client for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Full message encode/decode: XOR-MAPPED-ADDRESS (IPv4 + IPv6), MAPPED-ADDRESS, USERNAME, ERROR-CODE
- HMAC-SHA1 MESSAGE-INTEGRITY; CRC-32 FINGERPRINT
- ICE attributes: PRIORITY, USE-CANDIDATE, ICE-CONTROLLING, ICE-CONTROLLED
- Transaction client with retransmit
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-stun
```

## Usage

```typescript
import { encodeMessage, decodeMessage, createBindingRequest } from '@agentdance/node-webrtc-stun';

const req = createBindingRequest({ username: 'user:pass', priority: 12345 });
const buf = encodeMessage(req, 'password');
const msg = decodeMessage(buf);
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
