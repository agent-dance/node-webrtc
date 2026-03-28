# @agentdance/node-webrtc-sctp

RFC 4960 / RFC 8832 SCTP + DCEP for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Fragmentation & reassembly; SSN ordering
- Congestion control: cwnd / ssthresh / slow-start / congestion avoidance
- Fast retransmit on 3 duplicate SACKs; SACK gap blocks; FORWARD-TSN
- DCEP (RFC 8832): ordered, unordered, partial-reliability, pre-negotiated channels
- TSN wrap-around; clean SHUTDOWN sequence
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-sctp
```

## Usage

```typescript
import { SctpAssociation } from '@agentdance/node-webrtc-sctp';

const sctp = new SctpAssociation(dtlsTransport, { role: 'client', port: 5000 });
await sctp.connect();
const channel = await sctp.createDataChannel('chat');
channel.send('hello');
sctp.on('datachannel', (ch) => ch.on('message', console.log));
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
