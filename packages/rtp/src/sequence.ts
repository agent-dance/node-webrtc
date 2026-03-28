/**
 * Wrap-around aware sequence number utilities for RTP (RFC 3550 Section A.1).
 * Sequence numbers are 16-bit unsigned (0–65535).
 */

const MAX_SEQ = 0x10000; // 65536
const HALF_MAX_SEQ = 0x8000; // 32768

/**
 * Returns a - b, wrap-around aware.
 * Result is in range (-32768, 32768].
 */
export function seqDiff(a: number, b: number): number {
  const diff = ((a - b) & 0xffff) >>> 0;
  if (diff === 0) return 0;
  // If diff >= half the range, it wrapped around in the negative direction
  return diff < HALF_MAX_SEQ ? diff : diff - MAX_SEQ;
}

/** Returns true if a < b (wrap-around aware) */
export function seqLt(a: number, b: number): boolean {
  return seqDiff(a, b) < 0;
}

/** Returns true if a <= b (wrap-around aware) */
export function seqLte(a: number, b: number): boolean {
  return seqDiff(a, b) <= 0;
}

/** Returns true if a > b (wrap-around aware) */
export function seqGt(a: number, b: number): boolean {
  return seqDiff(a, b) > 0;
}

// NTP epoch is Jan 1, 1900; Unix epoch is Jan 1, 1970 — difference in seconds
const NTP_UNIX_OFFSET_S = BigInt(70 * 365 * 24 * 3600 + 17 * 24 * 3600); // 70 years + 17 leap days

/**
 * Convert a 64-bit NTP timestamp to Unix milliseconds.
 * NTP format: upper 32 bits = seconds since 1900-01-01,
 *             lower 32 bits = fractional seconds.
 */
export function ntpToUnix(ntp: bigint): number {
  const seconds = (ntp >> 32n) - NTP_UNIX_OFFSET_S;
  const fraction = ntp & 0xffffffffn;
  const ms = (fraction * 1000n) >> 32n;
  return Number(seconds) * 1000 + Number(ms);
}

/**
 * Convert Unix milliseconds to a 64-bit NTP timestamp.
 */
export function unixToNtp(ms: number): bigint {
  const totalMs = BigInt(ms);
  const seconds = totalMs / 1000n + NTP_UNIX_OFFSET_S;
  const remainder = totalMs % 1000n;
  const fraction = (remainder * (1n << 32n)) / 1000n;
  return (seconds << 32n) | fraction;
}
