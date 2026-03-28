# @agentdance/node-webrtc-sdp

WebRTC SDP parser / serializer for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Full parse ↔ serialize round-trip (RFC 4566 / WebRTC)
- extmap, rtpmap/fmtp, ssrc/ssrc-group, BUNDLE, DTLS fingerprint
- Chrome SDP interop
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-sdp
```

## Usage

```typescript
import { parse, serialize, parseCandidate } from '@agentdance/node-webrtc-sdp';

const session = parse(sdpString);
const text    = serialize(session);
const cand    = parseCandidate('candidate:…');
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
