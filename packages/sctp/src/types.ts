// SCTP over DTLS – RFC 4960 / RFC 8832 (DCEP)
// ---------------------------------------------------------------------------
// Types for SCTP and Data Channels

export type SctpState = 'new' | 'connecting' | 'connected' | 'closed' | 'failed';
export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';
export type DataChannelType = 'reliable' | 'reliable-ordered' | 'partial-reliable-rexmit' | 'partial-reliable-timed';

export interface SctpParameters {
  port: number;   // SCTP port (5000 by default)
  maxMessageSize: number;
}

export interface DataChannelOptions {
  label: string;
  ordered?: boolean;
  maxPacketLifeTime?: number;    // ms
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

export interface DataChannelInfo {
  id: number;
  label: string;
  protocol: string;
  ordered: boolean;
  maxPacketLifeTime: number | undefined;
  maxRetransmits: number | undefined;
  state: DataChannelState;
  negotiated?: boolean;
}

// SCTP chunk types (RFC 4960)
export const enum ChunkType {
  DATA = 0,
  INIT = 1,
  INIT_ACK = 2,
  SACK = 3,
  HEARTBEAT = 4,
  HEARTBEAT_ACK = 5,
  ABORT = 6,
  SHUTDOWN = 7,
  SHUTDOWN_ACK = 8,
  ERROR = 9,
  COOKIE_ECHO = 10,
  COOKIE_ACK = 11,
  SHUTDOWN_COMPLETE = 14,
  FORWARD_TSN = 192,
}

// PPID values (RFC 8832)
export const enum Ppid {
  DCEP = 50,         // DataChannel Establish Protocol
  STRING = 51,       // UTF-8 string
  BINARY = 53,       // Binary data
  STRING_EMPTY = 56, // Empty string
  BINARY_EMPTY = 57, // Empty binary
}

// DCEP message types (RFC 8832)
export const enum DcepType {
  DATA_CHANNEL_OPEN = 0x03,
  DATA_CHANNEL_ACK = 0x02,
}

// DataChannel open channel types
export const enum DcepChannelType {
  RELIABLE = 0x00,
  PARTIAL_RELIABLE_REXMIT = 0x01,
  PARTIAL_RELIABLE_TIMED = 0x02,
  RELIABLE_UNORDERED = 0x80,
  PARTIAL_RELIABLE_REXMIT_UNORDERED = 0x81,
  PARTIAL_RELIABLE_TIMED_UNORDERED = 0x82,
}
