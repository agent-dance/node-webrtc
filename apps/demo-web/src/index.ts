import { createHttpServer } from './server/http-server.js';
import { SignalingClient } from './server/signaling-client.js';
import { PeerManager } from './rtc/peer-manager.js';
import { AppStateManager } from './state/app-state.js';

const HTTP_PORT = 3000;
const SIGNALING_URL = 'ws://localhost:8080/ws';
const ROOM_ID = 'demo';
const PEER_ID = 'node-a';

async function main(): Promise<void> {
  const stateManager = new AppStateManager();
  const httpApp = createHttpServer(stateManager);

  const signalingClient = new SignalingClient(SIGNALING_URL, ROOM_ID, PEER_ID);
  const peerManager = new PeerManager(stateManager, signalingClient);

  signalingClient.onMessage(async (msg) => {
    switch (msg.type) {
      case 'joined': {
        if (msg.peerId) {
          console.log(`[Main] Already a peer in room: ${msg.peerId}, starting call`);
          await peerManager.startCall(msg.peerId);
        } else {
          console.log('[Main] Joined room, waiting for peer...');
        }
        break;
      }
      case 'peer-joined': {
        console.log(`[Main] Peer joined: ${msg.peerId}`);
        await peerManager.startCall(msg.peerId ?? 'unknown');
        break;
      }
      case 'peer-left': {
        console.log(`[Main] Peer left: ${msg.peerId}`);
        stateManager.update({ connectionState: 'disconnected', peerId: null });
        peerManager.close();
        break;
      }
      case 'answer': {
        await peerManager.handleAnswer(msg.payload);
        break;
      }
      case 'offer': {
        await peerManager.handleOffer(msg.payload);
        break;
      }
      case 'candidate': {
        peerManager.handleCandidate(msg.payload);
        break;
      }
    }
  });

  // Start signaling connection
  signalingClient.connect();

  // Start HTTP server
  httpApp.listen(HTTP_PORT, () => {
    console.log(`[Main] HTTP server listening on http://localhost:${HTTP_PORT}`);
    console.log(`[Main] Open http://localhost:${HTTP_PORT} to view demo status`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Main] Shutting down...');
    signalingClient.close();
    peerManager.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
