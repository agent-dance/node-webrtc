import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppStateManager } from '../state/app-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createHttpServer(stateManager: AppStateManager): express.Express {
  const app = express();

  // Serve static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON state snapshot
  app.get('/api/state', (_req, res) => {
    res.json(stateManager.get());
  });

  // SSE state stream (200ms interval)
  app.get('/api/state/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const send = (): void => {
      const data = JSON.stringify(stateManager.get());
      res.write(`data: ${data}\n\n`);
    };

    // Send immediately
    send();

    const interval = setInterval(send, 200);

    req.on('close', () => {
      clearInterval(interval);
    });
  });

  return app;
}
