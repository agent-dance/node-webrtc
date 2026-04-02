import { createHash, randomUUID } from 'crypto';
import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager, FileTransferStatus } from '../state/app-state.js';

// Keep each message ≤ 1 SCTP fragment (MAX_FRAGMENT_SIZE = 1172B).
// With 4-byte offset header, usable payload = 1168 bytes.
const CHUNK_SIZE = 1168; // 1168 bytes – fits in exactly one SCTP fragment

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const FILE_CHANNEL_MAX_BUFFERED = parsePositiveIntEnv(
  'DEMO_SCENARIO1_MAX_BUFFERED',
  64 * 1024,
);
const FILE_CHANNEL_RETRY_MS = parsePositiveIntEnv(
  'DEMO_SCENARIO1_RETRY_MS',
  50,
);
const FILE_CHANNEL_BURST_CHUNKS = parsePositiveIntEnv(
  'DEMO_SCENARIO1_BURST_CHUNKS',
  Number.MAX_SAFE_INTEGER,
);
const FILE_CHANNEL_BINARY_START_DELAY_MS = parsePositiveIntEnv(
  'DEMO_SCENARIO1_BINARY_START_DELAY_MS',
  0,
);
const FILE_CHANNEL_SIZE_BYTES = parsePositiveIntEnv(
  'DEMO_SCENARIO1_SIZE_BYTES',
  0,
);
const FILE_CHANNEL_META_ONLY = process.env.DEMO_SCENARIO1_META_ONLY === '1';
const FILE_CHANNEL_USE_TEXT_CHUNKS = process.env.DEMO_SCENARIO1_USE_TEXT_CHUNKS === '1';

export interface Scenario1RuntimeOptions {
  fileCount?: number;
  chunkSize?: number;
  ordered?: boolean;
  maxRetransmits?: number;
  descriptorMode?: boolean;
  maxBuffered?: number;
  retryMs?: number;
  burstChunks?: number;
  startDelayMs?: number;
  metaOnly?: boolean;
  useTextChunks?: boolean;
  sequential?: boolean;
}

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
  payload: {
    id: string;
    name: string;
    size: number;
    sha256: string;
    generatorIndex?: number;
    transportMode?: 'raw' | 'descriptor';
  };
}

interface EofMessage {
  type: 'EOF';
  payload: { id: string };
}

interface AckMessage {
  type: 'ACK';
  payload: { id: string; ok: boolean; sha256: string };
}

interface ChunkMessage {
  type: 'CHUNK';
  payload: {
    id: string;
    offset: number;
    length?: number;
    dataBase64?: string;
  };
}

/** Send a single file over a dedicated DataChannel */
async function sendFile(
  pc: RTCPeerConnection,
  fileIndex: number,
  state: AppStateManager,
  options: Scenario1RuntimeOptions,
): Promise<void> {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const descriptorMode = options.descriptorMode ?? false;
  const fileId = randomUUID();
  const size = FILE_CHANNEL_SIZE_BYTES > 0
    ? FILE_CHANNEL_SIZE_BYTES
    : 256 * 1024 + fileIndex * 100 * 1024; // vary sizes ~256–756KB
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

  const channelInit = {
    ordered: options.ordered ?? true,
    ...(options.maxRetransmits !== undefined
      ? { maxRetransmits: options.maxRetransmits }
      : {}),
  };
  const channel: RTCDataChannel = pc.createDataChannel(`file-${fileId}`, channelInit);
  console.log(`[Scenario1] created channel label=file-${fileId} id=${channel.id} readyState=${channel.readyState}`);

  await new Promise<void>((resolve, reject) => {
    channel.on('open', () => {
      console.log(`[Scenario1] channel OPEN: file-${fileId}`);
      // Send FILE_META
      const meta: FileMeta = {
        type: 'FILE_META',
        payload: {
          id: fileId,
          name,
          size,
          sha256,
          generatorIndex: fileIndex,
          transportMode: descriptorMode ? 'descriptor' : 'raw',
        },
      };
      channel.send(JSON.stringify(meta));
      console.log(`[Scenario1] META sent: file-${fileId}`);

      const metaOnly = options.metaOnly ?? FILE_CHANNEL_META_ONLY;
      if (metaOnly) {
        return;
      }

      // Stream chunks with backpressure
      let offset = 0;

      const sendChunks = (): void => {
        let chunksSentThisTick = 0;
        while (offset < content.length) {
          const maxBuffered = options.maxBuffered ?? FILE_CHANNEL_MAX_BUFFERED;
          const retryMs = options.retryMs ?? FILE_CHANNEL_RETRY_MS;
          const burstChunks = options.burstChunks ?? FILE_CHANNEL_BURST_CHUNKS;
          if (channel.bufferedAmount > maxBuffered) {
            setTimeout(sendChunks, retryMs);
            return;
          }
          const end = Math.min(offset + chunkSize, content.length);
          const chunk = content.slice(offset, end);

          const useTextChunks = options.useTextChunks ?? FILE_CHANNEL_USE_TEXT_CHUNKS;
          if (descriptorMode) {
            const msg: ChunkMessage = {
              type: 'CHUNK',
              payload: {
                id: fileId,
                offset,
                length: chunk.length,
              },
            };
            channel.send(JSON.stringify(msg));
          } else if (useTextChunks) {
            const msg: ChunkMessage = {
              type: 'CHUNK',
              payload: {
                id: fileId,
                offset,
                dataBase64: chunk.toString('base64'),
              },
            };
            channel.send(JSON.stringify(msg));
          } else {
            // 4-byte header: offset (uint32 big-endian) + data
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(offset, 0);
            channel.send(Buffer.concat([header, chunk]));
          }

          offset = end;
          chunksSentThisTick++;

          // Update state
          const files = state.get().scenario1.files.map((f) =>
            f.id === fileId ? { ...f, bytesSent: offset } : f,
          );
          state.updateScenario1({ files });

          if (chunksSentThisTick >= burstChunks) {
            setTimeout(sendChunks, 0);
            return;
          }
        }

        // Send EOF
        const eof: EofMessage = { type: 'EOF', payload: { id: fileId } };
        channel.send(JSON.stringify(eof));
      };

      const startDelayMs =
        options.startDelayMs ?? FILE_CHANNEL_BINARY_START_DELAY_MS;
      if (startDelayMs > 0) {
        setTimeout(sendChunks, startDelayMs);
      } else {
        sendChunks();
      }
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
  options: Scenario1RuntimeOptions = {},
): void {
  const envFileCount = Number.parseInt(
    process.env.DEMO_SCENARIO1_FILE_COUNT ?? '',
    10,
  );
  const fileCountFromEnv = Number.isFinite(envFileCount) && envFileCount > 0
    ? envFileCount
    : undefined;
  const FILE_COUNT = options.fileCount ?? fileCountFromEnv ?? 5;

  state.updateScenario1({
    totalFiles: FILE_COUNT,
    completedFiles: 0,
    files: [],
    startTime: Date.now(),
    endTime: null,
  });

  const run = async (): Promise<void> => {
    if (options.sequential) {
      for (let i = 0; i < FILE_COUNT; i++) {
        await sendFile(pc, i, state, options);
      }
      return;
    }

    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) => sendFile(pc, i, state, options)),
    );
  };

  void run()
    .then(() => {
      state.updateScenario1({ endTime: Date.now() });
      console.log('[Scenario1] All files transferred and verified');
    })
    .catch((err) => {
      console.error('[Scenario1] Error:', err);
    });
}
