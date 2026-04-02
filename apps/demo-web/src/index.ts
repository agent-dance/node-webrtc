import { createHttpServer } from './server/http-server.js';
import { SignalingClient } from './server/signaling-client.js';
import { PeerManager } from './rtc/peer-manager.js';
import {
  parseSignalingRole,
  shouldInitiateConnection,
} from './rtc/signaling-role.js';
import { AppStateManager } from './state/app-state.js';

const HTTP_PORT = 3000;
const SIGNALING_URL = 'ws://localhost:8080/ws';
const ROOM_ID = process.env.DEMO_ROOM_ID ?? 'demo';
const PEER_ID = process.env.DEMO_PEER_ID ?? 'node-a';
const LOCAL_SIGNALING_ROLE = parseSignalingRole(
  process.env.DEMO_SIGNALING_ROLE,
  'offerer',
);

async function main(): Promise<void> {
  const stateManager = new AppStateManager();
  const httpApp = createHttpServer(stateManager);

  const signalingClient = new SignalingClient(
    SIGNALING_URL,
    ROOM_ID,
    PEER_ID,
    LOCAL_SIGNALING_ROLE,
  );
  const peerManager = new PeerManager(stateManager, signalingClient);

  console.log(
    `[Main] Signaling role preference: ${LOCAL_SIGNALING_ROLE} (peerId=${PEER_ID}, room=${ROOM_ID})`,
  );

  const maybeStartCall = async (
    peerId: string | undefined,
    remoteRoleRaw: string | undefined,
    trigger: string,
  ): Promise<void> => {
    const resolvedPeerId = peerId ?? 'unknown';
    const remoteRole = parseSignalingRole(remoteRoleRaw, 'auto');
    const decision = shouldInitiateConnection(
      LOCAL_SIGNALING_ROLE,
      PEER_ID,
      remoteRole,
      resolvedPeerId,
    );
    console.log(
      `[Main] ${trigger}: local=${LOCAL_SIGNALING_ROLE}, remote=${remoteRole}, initiate=${decision.initiate} (${decision.reason})`,
    );

    if (decision.initiate) {
      await peerManager.startCall(resolvedPeerId);
    } else {
      stateManager.update({ peerId: resolvedPeerId });
    }
  };

  signalingClient.onMessage(async (msg) => {
    switch (msg.type) {
      case 'joined': {
        if (msg.peerId) {
          console.log(
            `[Main] Already a peer in room: ${msg.peerId} (remote role=${msg.role ?? 'auto'})`,
          );
          await maybeStartCall(msg.peerId, msg.role, 'joined');
        } else {
          console.log('[Main] Joined room, waiting for peer...');
        }
        break;
      }
      case 'peer-joined': {
        console.log(
          `[Main] Peer joined: ${msg.peerId} (remote role=${msg.role ?? 'auto'})`,
        );
        await maybeStartCall(msg.peerId, msg.role, 'peer-joined');
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
        await peerManager.handleOffer(
          msg.payload,
          msg.peerId ?? stateManager.get().peerId ?? 'unknown',
        );
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
