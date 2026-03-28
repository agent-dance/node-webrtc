export const STUN_MAGIC_COOKIE = 0x2112a442;

export enum MessageClass {
  Request = 0x0000,
  Indication = 0x0010,
  SuccessResponse = 0x0100,
  ErrorResponse = 0x0110,
}

export enum MessageMethod {
  Binding = 0x0001,
}

export interface StunMessage {
  messageClass: MessageClass;
  messageMethod: MessageMethod;
  transactionId: Buffer; // 12 bytes
  attributes: StunAttribute[];
}

export enum AttributeType {
  MappedAddress = 0x0001,
  Username = 0x0006,
  MessageIntegrity = 0x0008,
  ErrorCode = 0x0009,
  UnknownAttributes = 0x000a,
  Realm = 0x0014,
  Nonce = 0x0015,
  XorMappedAddress = 0x0020,
  Priority = 0x0024,
  UseCandidate = 0x0025,
  Software = 0x8022,
  AlternateServer = 0x8023,
  Fingerprint = 0x8028,
  IceControlled = 0x8029,
  IceControlling = 0x802a,
  NetworkCost = 0xc057,
}

export interface StunAttribute {
  type: AttributeType;
  value: Buffer;
}

export interface XorMappedAddress {
  family: 4 | 6;
  port: number;
  address: string;
}

export interface MappedAddress {
  family: 4 | 6;
  port: number;
  address: string;
}

export interface ErrorCode {
  code: number;
  reason: string;
}
