import WebSocket from 'ws';
import type { SignalingMessage, SignalingRole } from '../scenarios/types.js';

type MessageHandler = (msg: SignalingMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly roomId: string,
    private readonly peerId: string,
    private readonly role: SignalingRole,
  ) {}

  connect(): void {
    console.log(`[Signaling] Connecting to ${this.url}`);
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('[Signaling] Connected');
      this.send({
        type: 'join',
        room: this.roomId,
        id: this.peerId,
        role: this.role,
      });
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as SignalingMessage;
        for (const h of this.handlers) {
          h(msg);
        }
      } catch (err) {
        console.error('[Signaling] Parse error:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[Signaling] Disconnected, reconnecting in 3s...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[Signaling] Error:', err);
    });
  }

  send(msg: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[Signaling] Cannot send – not connected');
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
