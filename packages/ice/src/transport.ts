import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Packet type detection (RFC 7983 / RFC 5764)
// STUN:  first byte 0x00-0x03
// DTLS:  first byte 0x14-0x19 (ContentType: change_cipher_spec=20...23=heartbeat)
// RTP/RTCP: first byte 0x80-0xFF (version 2 flag set)
// ---------------------------------------------------------------------------

export function detectPacketType(
  buf: Buffer,
): 'stun' | 'dtls' | 'rtp' | 'unknown' {
  if (buf.length === 0) return 'unknown';
  const b = buf[0]!;
  if (b <= 0x03) return 'stun';
  if (b >= 0x14 && b <= 0x19) return 'dtls';
  if (b >= 0x80) return 'rtp';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// UdpTransport – single UDP socket with packet demultiplexing
// ---------------------------------------------------------------------------

export declare interface UdpTransport {
  on(event: 'stun', listener: (buf: Buffer, rinfo: dgram.RemoteInfo) => void): this;
  on(event: 'dtls', listener: (buf: Buffer, rinfo: dgram.RemoteInfo) => void): this;
  on(event: 'rtp', listener: (buf: Buffer, rinfo: dgram.RemoteInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export class UdpTransport extends EventEmitter {
  private _socket!: dgram.Socket;
  private _localPort = 0;
  private _localAddress = '0.0.0.0';

  get localPort(): number {
    return this._localPort;
  }

  get localAddress(): string {
    return this._localAddress;
  }

  async bind(port = 0, address = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');

      socket.on('error', (err) => {
        this.emit('error', err);
      });

      socket.on('message', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
        const type = detectPacketType(buf);
        this.emit(type, buf, rinfo);
      });

      socket.bind(port, address, () => {
        const addr = socket.address();
        this._localPort = addr.port;
        this._localAddress = addr.address;
        this._socket = socket;
        resolve();
      });

      socket.once('error', reject);
    });
  }

  send(buf: Buffer, port: number, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._socket.send(buf, port, address, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close(): void {
    try {
      this._socket.close();
    } catch {
      // already closed
    }
  }
}
