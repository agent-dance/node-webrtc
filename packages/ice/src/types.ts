export type CandidateType = 'host' | 'srflx' | 'relay' | 'prflx';
export type TransportProtocol = 'udp' | 'tcp';
export type IceRole = 'controlling' | 'controlled';

export enum IceAgentState {
  New = 'new',
  Gathering = 'gathering',
  Complete = 'complete',
  Failed = 'failed',
  Closed = 'closed',
}

export enum IceConnectionState {
  New = 'new',
  Checking = 'checking',
  Connected = 'connected',
  Completed = 'completed',
  Failed = 'failed',
  Disconnected = 'disconnected',
  Closed = 'closed',
}

export interface IceCandidate {
  foundation: string;
  component: 1 | 2; // 1=RTP, 2=RTCP
  transport: TransportProtocol;
  priority: number;
  address: string;
  port: number;
  type: CandidateType;
  relatedAddress?: string;
  relatedPort?: number;
  tcpType?: 'active' | 'passive' | 'so';
  generation?: number;
  ufrag?: string;
  networkId?: number;
}

export interface IceParameters {
  usernameFragment: string; // 4-256 characters
  password: string; // 22-256 characters
  iceLite?: boolean;
}

export interface CandidatePair {
  id: string;
  local: IceCandidate;
  remote: IceCandidate;
  state: CandidatePairState;
  priority: bigint;
  nominated: boolean;
  valid: boolean;
  nominateOnSuccess: boolean;
  lastBindingRequestReceived?: number;
  lastBindingResponseReceived?: number;
  retransmitCount: number;
  retransmitTimer?: NodeJS.Timeout;
}

export enum CandidatePairState {
  Waiting = 'waiting',
  InProgress = 'in-progress',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Frozen = 'frozen',
}

export interface IceAgentOptions {
  ufrag?: string;
  password?: string;
  role?: IceRole;
  tiebreaker?: bigint;
  stunServers?: Array<{ host: string; port: number }>;
  lite?: boolean; // ICE lite mode
  portRange?: { min: number; max: number };
  nomination?: 'regular' | 'aggressive';
}
