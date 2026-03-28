import * as dgram from 'node:dgram';
import { MessageClass, AttributeType } from './types.js';
import {
  createBindingRequest,
  decodeMessage,
  isStunMessage,
} from './message.js';
import { decodeXorMappedAddress, decodeMappedAddress } from './attributes.js';
import { StunTransaction } from './transaction.js';

export interface StunClientOptions {
  server: string;
  port: number;
  localPort?: number;
  timeout?: number; // ms, default 5000
}

export class StunClient {
  private readonly options: Required<StunClientOptions>;
  private socket: dgram.Socket | undefined;

  constructor(options: StunClientOptions) {
    this.options = {
      localPort: 0,
      timeout: 5000,
      ...options,
    };
  }

  async getExternalAddress(): Promise<{ address: string; port: number }> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      this.socket = socket;

      const request = createBindingRequest();
      let transaction: StunTransaction | undefined;

      const timeoutHandle = setTimeout(() => {
        transaction?.cancel();
        socket.close();
        reject(new Error('STUN binding request timed out'));
      }, this.options.timeout);

      socket.on('error', (err) => {
        clearTimeout(timeoutHandle);
        transaction?.cancel();
        socket.close();
        reject(err);
      });

      socket.on('message', (msg: Buffer) => {
        if (!isStunMessage(msg)) return;
        try {
          const decoded = decodeMessage(msg);
          if (
            decoded.transactionId.equals(request.transactionId) &&
            decoded.messageClass === MessageClass.SuccessResponse
          ) {
            transaction?.handleResponse(decoded);
          }
        } catch {
          // ignore malformed messages
        }
      });

      socket.bind(this.options.localPort, () => {
        const sendFn = (buf: Buffer): void => {
          socket.send(buf, this.options.port, this.options.server);
        };

        transaction = new StunTransaction(
          request,
          sendFn,
          (response) => {
            clearTimeout(timeoutHandle);
            socket.close();

            // Extract XOR-MAPPED-ADDRESS or MAPPED-ADDRESS
            const xorAttr = response.attributes.find(
              (a) => a.type === AttributeType.XorMappedAddress,
            );
            if (xorAttr) {
              const addr = decodeXorMappedAddress(
                xorAttr.value,
                response.transactionId,
              );
              resolve({ address: addr.address, port: addr.port });
              return;
            }

            const mappedAttr = response.attributes.find(
              (a) => a.type === AttributeType.MappedAddress,
            );
            if (mappedAttr) {
              const addr = decodeMappedAddress(mappedAttr.value);
              resolve({ address: addr.address, port: addr.port });
              return;
            }

            reject(new Error('No address attribute in STUN response'));
          },
          () => {
            clearTimeout(timeoutHandle);
            socket.close();
            reject(new Error('STUN transaction timed out'));
          },
          500,
        );

        transaction.start();
      });
    });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = undefined;
  }
}
