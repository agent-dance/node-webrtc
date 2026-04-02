// Signaling message types
export type SignalingMessageType =
  | 'join'
  | 'joined'
  | 'peer-joined'
  | 'peer-left'
  | 'offer'
  | 'answer'
  | 'candidate'
  | 'leave'
  | 'error';

export type SignalingRole = 'offerer' | 'answerer' | 'auto';

export interface SignalingMessage {
  type: SignalingMessageType;
  room?: string;
  id?: string;
  peerId?: string;
  role?: SignalingRole;
  payload?: unknown;
}

// ChannelEnvelope – all DataChannel messages use this framing
export type ChannelMessageType =
  | 'FILE_META'
  | 'CHUNK'
  | 'EOF'
  | 'ACK'
  | 'LARGE_FILE_META'
  | 'READY'
  | 'LARGE_CHUNK'
  | 'EOF_MARKER'
  | 'VERIFY_RESULT'
  | 'INPUT'
  | 'STATE'
  | 'PING'
  | 'PONG'
  | 'VIDEO_FRAME';

export interface ChannelEnvelope {
  type: ChannelMessageType;
  payload?: unknown;
}
