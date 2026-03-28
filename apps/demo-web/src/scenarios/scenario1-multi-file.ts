import { createHash, randomUUID } from 'crypto';
import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager, FileTransferStatus } from '../state/app-state.js';

// Keep each message ≤ 1 SCTP fragment (MAX_FRAGMENT_SIZE = 1172B).
// With 4-byte offset header, usable payload = 1168 bytes.
const CHUNK_SIZE = 1168; // 1168 bytes – fits in exactly one SCTP fragment

/** Generate a deterministic file content for testing */
function generateFileContent(fileIndex: number, size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (fileIndex * 17 + i) & 0xff;
  }
  return buf;
}

interface FileMeta {
  type: 'FILE_META';
  payload: { id: string; name: string; size: number; sha256: string };
}

interface EofMessage {
  type: 'EOF';
  payload: { id: string };
}

interface AckMessage {
  type: 'ACK';
  payload: { id: string; ok: boolean; sha256: string };
}

/** Send a single file over a dedicated DataChannel */
async function sendFile(
  pc: RTCPeerConnection,
  fileIndex: number,
  state: AppStateManager,
): Promise<void> {
  const fileId = randomUUID();
  const size = 256 * 1024 + fileIndex * 100 * 1024; // vary sizes ~256–756KB
  const content = generateFileContent(fileIndex, size);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const name = `file-${fileIndex}.bin`;

  const status: FileTransferStatus = {
    id: fileId,
    name,
    size,
    bytesSent: 0,
    sha256,
    verified: null,
  };

  const current = state.get().scenario1;
  state.updateScenario1({
    files: [...current.files, status],
  });

  const channel: RTCDataChannel = pc.createDataChannel(`file-${fileId}`, { ordered: true });
  console.log(`[Scenario1] created channel label=file-${fileId} id=${channel.id} readyState=${channel.readyState}`);

  await new Promise<void>((resolve, reject) => {
    channel.on('open', () => {
      console.log(`[Scenario1] channel OPEN: file-${fileId}`);
      // Send FILE_META
      const meta: FileMeta = {
        type: 'FILE_META',
        payload: { id: fileId, name, size, sha256 },
      };
      channel.send(JSON.stringify(meta));

      // Stream chunks with backpressure
      let offset = 0;

      const sendChunks = (): void => {
        while (offset < content.length) {
          if (channel.bufferedAmount > 64 * 1024) {
            // Back-pressure: retry after 50ms
            setTimeout(sendChunks, 50);
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, content.length);
          const chunk = content.slice(offset, end);

          // 4-byte header: offset (uint32 big-endian) + data
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(offset, 0);
          channel.send(Buffer.concat([header, chunk]));

          offset = end;

          // Update state
          const files = state.get().scenario1.files.map((f) =>
            f.id === fileId ? { ...f, bytesSent: offset } : f,
          );
          state.updateScenario1({ files });
        }

        // Send EOF
        const eof: EofMessage = { type: 'EOF', payload: { id: fileId } };
        channel.send(JSON.stringify(eof));
      };

      sendChunks();
    });

    channel.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as AckMessage;
        if (msg.type === 'ACK' && msg.payload.id === fileId) {
          const verified = msg.payload.ok && msg.payload.sha256 === sha256;
          const files = state.get().scenario1.files.map((f) =>
            f.id === fileId ? { ...f, verified } : f,
          );
          const completedFiles = files.filter((f) => f.verified !== null).length;
          state.updateScenario1({ files, completedFiles });

          channel.close();
          resolve();
        }
      } catch {
        // binary chunk (should not happen on this channel)
      }
    });

    channel.on('error', reject);
    channel.on('close', () => resolve());
  });
  console.log(`[Scenario1] sendFile done: file-${fileId}`);
}

/**
 * Register scenario 1: concurrent small-file transfers.
 * We open all channels before createOffer() is called.
 * Actual sending starts when each channel opens.
 */
export function registerScenario1Channels(
  pc: RTCPeerConnection,
  state: AppStateManager,
): void {
  const FILE_COUNT = 5;

  state.updateScenario1({
    totalFiles: FILE_COUNT,
    completedFiles: 0,
    files: [],
    startTime: Date.now(),
    endTime: null,
  });

  const promises: Promise<void>[] = [];

  for (let i = 0; i < FILE_COUNT; i++) {
    promises.push(sendFile(pc, i, state));
  }

  Promise.all(promises)
    .then(() => {
      state.updateScenario1({ endTime: Date.now() });
      console.log('[Scenario1] All files transferred and verified');
    })
    .catch((err) => {
      console.error('[Scenario1] Error:', err);
    });
}
