# @agentdance/node-webrtc-rtp

RFC 3550 RTP / RTCP codec for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- RTP encode/decode: header, CSRC, one-byte & two-byte header extensions
- RTCP: SR, RR, SDES, BYE, NACK, PLI, FIR, REMB, compound packets
- Utilities: `seqDiff`, `ntpToUnix`, `unixToNtp`, `isRtpPacket`, `isRtcpPacket`
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-rtp
```

## Usage

```typescript
import { encodeRtp, decodeRtp, decodeRtcp } from '@agentdance/node-webrtc-rtp';

const packet = encodeRtp({ payloadType: 96, sequenceNumber: 1, timestamp: 0, ssrc: 42, payload });
const { header, payload } = decodeRtp(packet);
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
