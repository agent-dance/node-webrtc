import { ReplayWindow } from './replay.js';

// ---------------------------------------------------------------------------
// Protection profiles
// ---------------------------------------------------------------------------

export enum ProtectionProfile {
  AES_128_CM_HMAC_SHA1_80 = 0x0001,
  AES_128_CM_HMAC_SHA1_32 = 0x0002,
  AES_128_GCM = 0x0007,
  AES_256_GCM = 0x0008,
}

// ---------------------------------------------------------------------------
// Keying material supplied by DTLS-SRTP or an external SRTP offer
// ---------------------------------------------------------------------------

export interface SrtpKeyingMaterial {
  /** 16 bytes for AES-128 profiles; 32 bytes for AES-256 */
  masterKey: Buffer;
  /** 14 bytes */
  masterSalt: Buffer;
  profile: ProtectionProfile;
}

// ---------------------------------------------------------------------------
// Per-stream cryptographic contexts
// ---------------------------------------------------------------------------

export interface SrtpContext {
  profile: ProtectionProfile;
  /** AES session encryption key */
  sessionEncKey: Buffer;
  /** HMAC-SHA1 authentication key – 20 bytes */
  sessionAuthKey: Buffer;
  /** 14-byte session salt used to compute the IV */
  sessionSaltKey: Buffer;
  /** Full 48-bit packet index: (ROC << 16) | SEQ */
  index: bigint;
  /** Roll-Over Counter */
  rolloverCounter: number;
  /** Last observed RTP sequence number */
  lastSeq: number;
  replayWindow: ReplayWindow;
}

export interface SrtcpContext {
  profile: ProtectionProfile;
  sessionEncKey: Buffer;
  sessionAuthKey: Buffer;
  sessionSaltKey: Buffer;
  /** 31-bit SRTCP packet index (starts at 1 on first protect call) */
  index: number;
  replayWindow: ReplayWindow;
}
