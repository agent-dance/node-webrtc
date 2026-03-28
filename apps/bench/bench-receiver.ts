/**
 * bench-receiver.ts — Answerer / Receiver 子进程
 *
 * 接收 500MB 数据，SHA-256 校验后回报 VERIFY 结果。
 *
 * 信令消息格式（IPC）：
 *   父→子: { type: 'offer', sdp }
 *         { type: 'candidate', candidate, sdpMid, sdpMLineIndex }
 *   子→父: { type: 'answer', sdp }
 *         { type: 'candidate', candidate, sdpMid, sdpMLineIndex }
 *         { type: 'ready' }
 */

import { createHash } from 'node:crypto';
import { RTCPeerConnection } from '@agentdance/node-webrtc';

const TOTAL_SIZE   = 500 * 1024 * 1024;
const CHUNK_SIZE   = 1168;
const REPORT_BYTES = 50 * 1024 * 1024; // 每收到 50 MB 打印一次

function send(msg: unknown): void {
  process.send!(msg);
}

async function main(): Promise<void> {
  const pc = new RTCPeerConnection({ iceServers: [] });

  pc.on('icecandidate', (init) => {
    if (init) send({ type: 'candidate', ...init });
  });

  // 预分配接收 buffer（与 Flutter 侧相同策略）
  const recvBuffer    = Buffer.allocUnsafe(TOTAL_SIZE);
  let bytesReceived   = 0;
  let startTime: number | null = null;
  let nextReportAt    = REPORT_BYTES;
  const hasher        = createHash('sha256');

  // ── 接收主进程信令 ─────────────────────────────────────────────────────
  process.on('message', async (msg: Record<string, unknown>) => {
    if (msg.type === 'offer') {
      await pc.setRemoteDescription(msg as { type: 'offer'; sdp: string });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', sdp: answer.sdp });
    } else if (msg.type === 'candidate') {
      await pc.addIceCandidate(msg as { candidate: string; sdpMid: string; sdpMLineIndex: number })
        .catch(() => {});
    }
  });

  // ── DataChannel ────────────────────────────────────────────────────────
  pc.on('datachannel', (channel) => {
    process.stderr.write(`[receiver] datachannel open: ${channel.label}\n`);

    channel.on('message', (data: Buffer | string) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);

      // JSON 控制消息（EOF）
      if (buf[0] === 0x7b) { // '{'
        try {
          const msg = JSON.parse(buf.toString()) as { type: string; sha256: string };
          if (msg.type === 'EOF') {
            const endTime   = Date.now();
            const elapsed   = endTime - startTime!;
            const sha256    = hasher.digest('hex');
            const ok        = sha256 === msg.sha256;
            const avgMbps   = TOTAL_SIZE / (1024 * 1024) / (elapsed / 1000);

            process.stderr.write(
              `[receiver] EOF received. bytes=${bytesReceived}` +
              `  elapsed=${elapsed}ms  avg=${avgMbps.toFixed(2)} MB/s\n` +
              `[receiver] sha256 match=${ok}\n` +
              `[receiver]   local : ${sha256}\n` +
              `[receiver]   remote: ${msg.sha256}\n`,
            );

            channel.send(JSON.stringify({
              type: 'VERIFY',
              ok,
              elapsed_ms: elapsed,
              sha256,
            }));

            setTimeout(() => {
              pc.close();
              process.exit(0);
            }, 500);
          }
        } catch { /* ignore */ }
        return;
      }

      // 二进制数据块：[4B seq BE][payload]
      if (buf.length < 4) return;
      if (startTime === null) startTime = Date.now();

      const seq       = buf.readUInt32BE(0);
      const payload   = buf.subarray(4);
      const offset    = seq * CHUNK_SIZE;

      if (offset + payload.length <= recvBuffer.length) {
        recvBuffer.copy(recvBuffer, offset, 0, 0); // no-op; we write directly
        payload.copy(recvBuffer, offset);
        hasher.update(payload);
        bytesReceived += payload.length;

        if (bytesReceived >= nextReportAt) {
          const elapsed = Date.now() - startTime!;
          const mbps    = bytesReceived / (1024 * 1024) / (elapsed / 1000);
          process.stderr.write(
            `[receiver] ${(bytesReceived / 1024 / 1024).toFixed(0)} MB` +
            `  avg=${mbps.toFixed(1)} MB/s\n`,
          );
          nextReportAt += REPORT_BYTES;
        }
      }
    });

    send({ type: 'ready' });
  });
}

main().catch((err) => {
  process.stderr.write(`[receiver] fatal: ${err}\n`);
  process.exit(1);
});
