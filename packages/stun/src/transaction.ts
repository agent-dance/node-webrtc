import { type StunMessage } from './types.js';
import { encodeMessage } from './message.js';

// RFC 5389 §7.2.1 – UDP retransmission schedule:
// Send at t=0, retransmit at t=RTO, 3*RTO, 7*RTO, 15*RTO (wait up to 16*RTO)
// i.e., intervals: RTO, 2*RTO, 4*RTO, 8*RTO, 16*RTO
// 5 retransmissions total (6 sends: attempt 0..5, but attempt 5 is the last wait)
const MAX_ATTEMPTS = 7; // RFC 5389: Rc = 7 for UDP

export class StunTransaction {
  readonly transactionId: Buffer;
  private retransmitTimer: ReturnType<typeof setTimeout> | undefined =
    undefined;
  private attempt: number = 0;
  private cancelled = false;
  private responded = false;

  constructor(
    private readonly request: StunMessage,
    private readonly send: (buf: Buffer) => void,
    private readonly onResponse: (response: StunMessage) => void,
    private readonly onTimeout: () => void,
    private readonly rto: number = 500,
  ) {
    this.transactionId = request.transactionId;
  }

  start(): void {
    this.attempt = 0;
    this.cancelled = false;
    this.responded = false;
    this._sendAttempt();
  }

  private _sendAttempt(): void {
    if (this.cancelled || this.responded) return;

    const buf = encodeMessage(this.request);
    this.send(buf);

    if (this.attempt >= MAX_ATTEMPTS) {
      // Last attempt sent – start the final wait timer (2^Rm * RTO)
      // RFC 5389: Rm = 16, so wait 1600 ms on last attempt with default RTO=100ms
      // With variable rto we wait 2*rto after last send.
      this.retransmitTimer = setTimeout(() => {
        if (!this.cancelled && !this.responded) {
          this.onTimeout();
        }
      }, 2 * this.rto);
      return;
    }

    // Exponential back-off: interval = 2^attempt * rto
    const interval = Math.pow(2, this.attempt) * this.rto;
    this.attempt++;

    this.retransmitTimer = setTimeout(() => {
      this._sendAttempt();
    }, interval);
  }

  handleResponse(msg: StunMessage): void {
    if (this.cancelled || this.responded) return;
    this.responded = true;
    this._clearTimer();
    this.onResponse(msg);
  }

  cancel(): void {
    this.cancelled = true;
    this._clearTimer();
  }

  private _clearTimer(): void {
    const t = this.retransmitTimer;
    if (t !== undefined) {
      clearTimeout(t);
      this.retransmitTimer = undefined;
    }
  }
}
