/**
 * bench-sender.ts — Offerer / Sender 子进程
 *
 * 通过 process.send / process.on('message') 与主进程交换信令。
 * 建立 RTCPeerConnection 后发送 500MB 数据，报告速度。
 *
 * 信令消息格式（IPC）：
 *   父→子: { type: 'answer', sdp }
 *         { type: 'candidate', candidate, sdpMid, sdpMLineIndex }
 *   子→父: { type: 'offer', sdp }
 *         { type: 'candidate', candidate, sdpMid, sdpMLineIndex }
 *         { type: 'done', stats }
 *         { type: 'error', message }
 */

import { createHash } from 'node:crypto';
import { RTCPeerConnection } from '@agentdance/node-webrtc';

const TOTAL_SIZE  = 500 * 1024 * 1024; // 500 MB
const CHUNK_SIZE  = 1168;               // 1 SCTP fragment（4B header + 1164B payload）
const HIGH_WM     = 4 * 1024 * 1024;   // 4 MB — 停止填充
const LOW_WM      = 2 * 1024 * 1024;   // 2 MB — 恢复填充
const REPORT_MS   = 3_000;             // 每 3s 打印进度

function send(msg: unknown): void {
  process.send!(msg);
}

async function main(): Promise<void> {
  const pc = new RTCPeerConnection({ iceServers: [] });

  // ── ICE candidate 转发 ─────────────────────────────────────────────────
  pc.on('icecandidate', (init) => {
    if (init) send({ type: 'candidate', ...init });
  });

  // ── 接收主进程信令 ────────────────────────────────────────────────────
  process.on('message', async (msg: Record<string, unknown>) => {
    if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg as { type: 'answer'; sdp: string });
    } else if (msg.type === 'candidate') {
      await pc.addIceCandidate(msg as { candidate: string; sdpMid: string; sdpMLineIndex: number })
        .catch(() => {});
    }
  });

  // ── DataChannel 设置 ───────────────────────────────────────────────────
  const channel = pc.createDataChannel('bench', { ordered: true });
  channel.bufferedAmountLowThreshold = LOW_WM;

  channel.on('open', () => {
    const hasher      = createHash('sha256');
    let bytesSent     = 0;
    let seqNum        = 0;
    let paused        = false;
    let lastBytes     = 0;
    let lastTime      = Date.now();
    const startTime   = lastTime;

    const reportTimer = setInterval(() => {
      const now = Date.now();
      const dt  = (now - lastTime) / 1000;
      const db  = bytesSent - lastBytes;
      const mbps = db / dt / (1024 * 1024);
      const pct  = (bytesSent / TOTAL_SIZE * 100).toFixed(1);
      process.stderr.write(
        `[sender] ${pct}%  ${(bytesSent / 1024 / 1024).toFixed(0)} MB` +
        `  speed=${mbps.toFixed(1)} MB/s` +
        `  buffered=${(channel.bufferedAmount / 1024).toFixed(0)} KB\n`,
      );
      lastBytes = bytesSent;
      lastTime  = now;
    }, REPORT_MS);
    reportTimer.unref();

    const pump = (): void => {
      if (paused) return;
      while (bytesSent < TOTAL_SIZE) {
        if (channel.bufferedAmount > HIGH_WM) {
          paused = true;
          return;
        }
        const payloadSize = Math.min(CHUNK_SIZE, TOTAL_SIZE - bytesSent);
        const payload     = Buffer.allocUnsafe(payloadSize);
        for (let i = 0; i < payloadSize; i++) {
          payload[i] = (seqNum * 251 + i * 13) & 0xff;
        }
        hasher.update(payload);

        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(seqNum, 0);
        channel.send(Buffer.concat([header, payload]));

        bytesSent += payloadSize;
        seqNum++;
      }

      // 所有数据已入队
      clearInterval(reportTimer);
      const sha256 = hasher.digest('hex');
      const elapsed = Date.now() - startTime;
      process.stderr.write(
        `[sender] all enqueued: ${(TOTAL_SIZE / 1024 / 1024).toFixed(0)} MB` +
        `  sha256=${sha256}\n`,
      );
      channel.send(JSON.stringify({ type: 'EOF', sha256 }));
    };

    channel.on('bufferedamountlow', () => {
      if (paused) {
        paused = false;
        pump();
      }
    });

    pump();
  });

  channel.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; ok: boolean; elapsed_ms: number; sha256: string };
      if (msg.type === 'VERIFY') {
        const avgMbps = TOTAL_SIZE / (1024 * 1024) / (msg.elapsed_ms / 1000);
        process.stderr.write(
          `[sender] VERIFY ok=${msg.ok}  avg=${avgMbps.toFixed(2)} MB/s  ` +
          `remote_sha256=${msg.sha256}\n`,
        );
        send({ type: 'done', ok: msg.ok, elapsed_ms: msg.elapsed_ms, avg_mbps: avgMbps });
        pc.close();
        process.exit(0);
      }
    } catch { /* ignore */ }
  });

  channel.on('error', (err) => {
    process.stderr.write(`[sender] channel error: ${err}\n`);
  });

  // ── Offer ──────────────────────────────────────────────────────────────
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: offer.sdp });
}

main().catch((err) => {
  process.stderr.write(`[sender] fatal: ${err}\n`);
  process.exit(1);
});
