/**
 * RFC 3711 Section 3.3.2 – Sliding window replay protection.
 * The window tracks the highest received index and a bitmask of the
 * WINDOW_SIZE packets below it.
 */
export class ReplayWindow {
  private top: bigint = -1n;
  private bitmask: bigint = 0n;
  private readonly windowSize: bigint;

  constructor(windowSize: bigint = 64n) {
    this.windowSize = windowSize;
  }

  /**
   * Returns true if the packet index is acceptable (not replayed, inside window
   * or ahead of it).
   */
  check(index: bigint): boolean {
    if (this.top === -1n) {
      // Window not yet initialised – accept any packet.
      return true;
    }
    if (index > this.top) {
      // Ahead of the window – always accept.
      return true;
    }
    const diff = this.top - index;
    if (diff >= this.windowSize) {
      // Too old – outside the window.
      return false;
    }
    // Inside the window – accept only if not already seen.
    const bit = 1n << diff;
    return (this.bitmask & bit) === 0n;
  }

  /**
   * Mark index as received and advance the window top if necessary.
   * Must only be called after a successful auth-tag check.
   */
  update(index: bigint): void {
    if (index > this.top) {
      // Advance the window.
      const shift = index - this.top;
      this.bitmask = (this.bitmask << shift) | 1n;
      this.top = index;
    } else {
      const diff = this.top - index;
      const bit = 1n << diff;
      this.bitmask |= bit;
    }
    // Keep bitmask bounded to windowSize bits.
    const mask = (1n << this.windowSize) - 1n;
    this.bitmask &= mask;
  }
}
