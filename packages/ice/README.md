# @agentdance/node-webrtc-ice

RFC 8445 ICE agent for Node.js — part of the [`@agentdance/node-webrtc`](https://github.com/agent-dance/node-webrtc) pure-TypeScript WebRTC stack.

## Features

- Host / srflx / prflx candidate gathering
- Connectivity checks with retransmit schedule (0 / 200 / 600 / 1400 / 3800 ms)
- Aggressive & regular nomination
- 15 s keepalive, 30 s connect timeout
- BigInt pair-priority per RFC 8445 §6.1.2.3
- Zero native dependencies

## Install

```bash
npm install @agentdance/node-webrtc-ice
```

## Usage

```typescript
import { IceAgent } from '@agentdance/node-webrtc-ice';

const agent = new IceAgent({ role: 'controlling', stunServers: [] });
await agent.gather();
agent.setRemoteParameters({ usernameFragment: '…', password: '…' });
agent.addRemoteCandidate(candidate);
await agent.connect();
agent.send(Buffer.from('data'));
agent.on('data', (buf) => console.log(buf));
```

## Full Documentation

See the [main package README](https://github.com/agent-dance/node-webrtc#readme) for the complete API reference, usage examples, and architecture overview.

## License

MIT
