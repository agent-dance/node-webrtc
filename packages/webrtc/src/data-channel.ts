import { EventEmitter } from 'events';
import type { RTCDataChannelInit, RTCDataChannelState } from './types.js';
import type { SctpDataChannel } from '@agentdance/node-webrtc-sctp';

export declare interface RTCDataChannel {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer | string | ArrayBuffer) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'closing', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'bufferedamountlow', listener: () => void): this;
}

export class RTCDataChannel extends EventEmitter {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  id: number | null;
  readyState: RTCDataChannelState = 'connecting';
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';

  // bufferedAmount tracks bytes enqueued but not yet acknowledged
  private _bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;

  // Internal reference to the SCTP layer channel
  _sctpChannel: SctpDataChannel | null;

  constructor(
    label: string,
    init: RTCDataChannelInit,
    sctpChannel: SctpDataChannel | null,
  ) {
    super();
    this.label = label;
    this.ordered = init.ordered ?? true;
    this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
    this.maxRetransmits = init.maxRetransmits ?? null;
    this.protocol = init.protocol ?? '';
    this.negotiated = init.negotiated ?? false;
    this.id = init.id ?? null;
    this._sctpChannel = sctpChannel;

    if (sctpChannel) {
      this._bindSctpChannel(sctpChannel);
    }
  }

  get bufferedAmount(): number {
    // Delegate to the underlying SCTP channel so that bufferedAmount tracks
    // only bytes that have been enqueued but not yet acknowledged by the remote
    // peer.  This allows backpressure checks (channel.bufferedAmount >
    // HIGH_WATERMARK) to work correctly.
    if (this._sctpChannel) {
      return this._sctpChannel.bufferedAmount;
    }
    return this._bufferedAmount;
  }

  get bufferedAmountLowThreshold(): number {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this._bufferedAmountLowThreshold = value;
    // Propagate to underlying SCTP channel if bound
    if (this._sctpChannel) {
      this._sctpChannel.bufferedAmountLowThreshold = value;
    }
  }

  _bindSctpChannel(channel: SctpDataChannel): void {
    this._sctpChannel = channel;
    this.id = channel.id;

    // Sync threshold
    channel.bufferedAmountLowThreshold = this._bufferedAmountLowThreshold;

    channel.on('open', () => {
      console.log(`[RTCDataChannel] SCTP 'open' for label="${this.label}" (streamId=${this.id})`);
      this.readyState = 'open';
      this.emit('open');
    });

    channel.on('message', (data: Buffer | string) => {
      if (data instanceof Buffer && this.binaryType === 'arraybuffer') {
        // Expose as ArrayBuffer to match browser behaviour
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        this.emit('message', ab);
      } else {
        this.emit('message', data);
      }
    });

    channel.on('close', () => {
      this.readyState = 'closed';
      this._bufferedAmount = 0;
      this.emit('close');
    });

    channel.on('error', (err: Error) => {
      this.emit('error', err);
    });

    // Relay bufferedamountlow from SCTP layer
    channel.on('bufferedamountlow', () => {
      this.emit('bufferedamountlow');
    });

    // If already open (e.g. negotiated channel)
    if (channel.state === 'open') {
      this.readyState = 'open';
    }
  }

  send(data: string | Buffer | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') {
      const err = new Error(`DataChannel "${this.label}" is not open (state: ${this.readyState})`);
      (err as NodeJS.ErrnoException).code = 'InvalidStateError';
      throw err;
    }
    if (!this._sctpChannel) {
      throw new Error(`DataChannel "${this.label}" has no underlying SCTP channel`);
    }

    let buf: Buffer;
    if (typeof data === 'string') {
      // Track buffered bytes (UTF-8 encoded size)
      buf = Buffer.from(data, 'utf8');
      this._bufferedAmount += buf.byteLength;
      this._sctpChannel.send(data);
    } else if (data instanceof Buffer) {
      buf = data;
      this._bufferedAmount += buf.byteLength;
      this._sctpChannel.send(buf);
    } else if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
      this._bufferedAmount += buf.byteLength;
      this._sctpChannel.send(buf);
    } else {
      // ArrayBufferView
      const view = data as ArrayBufferView;
      buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      this._bufferedAmount += buf.byteLength;
      this._sctpChannel.send(buf);
    }
  }

  close(): void {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this.emit('closing');
    if (this._sctpChannel) {
      this._sctpChannel.close();
      // The 'close' event on _sctpChannel transitions us to 'closed'
    } else {
      // No underlying channel – transition immediately
      this.readyState = 'closed';
      this.emit('close');
    }
  }
}
