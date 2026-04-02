/**
 * bench.ts — 主进程
 *
 * fork sender + receiver 两个子进程，通过 IPC 桥接信令，
 * 等待 done 消息后汇报 500MB 传输结果。
 *
 * 运行：
 *   cd apps/bench && ../../node_modules/.bin/tsx bench.ts
 */

import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const repoRoot   = resolve(__dirname, '../..');

// 找到 tsx ESM loader（pnpm 把包放在 .pnpm 目录下）
function findTsxLoader(): string {
  const candidates: string[] = [];
  const pnpmStoreDir = join(repoRoot, 'node_modules/.pnpm');
  if (existsSync(pnpmStoreDir)) {
    for (const entry of readdirSync(pnpmStoreDir)) {
      if (entry.startsWith('tsx@')) {
        candidates.push(join(pnpmStoreDir, entry, 'node_modules/tsx/dist/esm/index.mjs'));
      }
    }
  }
  candidates.push(join(repoRoot, 'node_modules/tsx/dist/esm/index.mjs'));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // 兜底：直接用 tsx 的 --import 钩子名
  throw new Error('Cannot find tsx ESM loader. Run pnpm install first.');
}

const tsxLoader    = pathToFileURL(findTsxLoader()).href;
const senderPath   = join(__dirname, 'bench-sender.ts');
const receiverPath = join(__dirname, 'bench-receiver.ts');

console.log('='.repeat(60));
console.log('  ts-rtc 500MB DataChannel 吞吐量基准测试');
console.log('  路径: Node.js loopback (127.0.0.1)');
console.log('='.repeat(60));

const childOpts = {
  execPath: process.execPath,
  execArgv: ['--import', tsxLoader],
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'] as const,
};

const sender   = fork(senderPath,   [], childOpts);
const receiver = fork(receiverPath, [], childOpts);

const startWall = Date.now();

// ── 信令桥接 ─────────────────────────────────────────────────────────────────

sender.on('message', (msg: Record<string, unknown>) => {
  if (msg.type === 'offer' || msg.type === 'candidate') {
    receiver.send(msg);
  } else if (msg.type === 'done') {
    const wallMs = Date.now() - startWall;
    const { ok, elapsed_ms, avg_mbps } = msg as { ok: boolean; elapsed_ms: number; avg_mbps: number };
    console.log('\n' + '='.repeat(60));
    console.log('  基准测试完成');
    console.log(`  SHA-256 验证: ${ok ? '✅ 通过' : '❌ 失败'}`);
    console.log(`  传输耗时:    ${(elapsed_ms / 1000).toFixed(1)} s`);
    console.log(`  平均速度:    ${avg_mbps.toFixed(2)} MB/s`);
    console.log(`  总挂钟时间:  ${(wallMs / 1000).toFixed(1)} s`);
    console.log('='.repeat(60));
    process.exit(ok ? 0 : 1);
  }
});

receiver.on('message', (msg: Record<string, unknown>) => {
  if (msg.type === 'answer' || msg.type === 'candidate') {
    sender.send(msg);
  }
});

// ── 错误处理 ──────────────────────────────────────────────────────────────────

sender.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[bench] sender 异常退出 code=${code}`);
    receiver.kill();
    process.exit(1);
  }
});

receiver.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[bench] receiver 异常退出 code=${code}`);
    sender.kill();
    process.exit(1);
  }
});

// 超时保险：10 分钟
setTimeout(() => {
  console.error('[bench] 超时，强制结束子进程');
  sender.kill();
  receiver.kill();
  process.exit(1);
}, 10 * 60 * 1000).unref();
