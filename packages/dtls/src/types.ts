// DTLS 1.2 shared types

export enum ContentType {
  ChangeCipherSpec = 20,
  Alert = 21,
  Handshake = 22,
  ApplicationData = 23,
}

export enum AlertLevel {
  Warning = 1,
  Fatal = 2,
}

export enum AlertDescription {
  CloseNotify = 0,
  UnexpectedMessage = 10,
  BadRecordMac = 20,
  DecryptionFailed = 21,
  RecordOverflow = 22,
  DecompressionFailure = 30,
  HandshakeFailure = 40,
  NoCertificate = 41,
  BadCertificate = 42,
  UnsupportedCertificate = 43,
  CertificateRevoked = 44,
  CertificateExpired = 45,
  CertificateUnknown = 46,
  IllegalParameter = 47,
  UnknownCA = 48,
  AccessDenied = 49,
  DecodeError = 50,
  DecryptError = 51,
  ExportRestriction = 60,
  ProtocolVersion = 70,
  InsufficientSecurity = 71,
  InternalError = 80,
  UserCanceled = 90,
  NoRenegotiation = 100,
  UnsupportedExtension = 110,
}

export interface DtlsVersion {
  major: number;
  minor: number;
}

/** DTLS 1.2 = {254, 253} */
export const DTLS_VERSION_1_2: DtlsVersion = { major: 254, minor: 253 };

export interface DtlsRecord {
  contentType: ContentType;
  version: DtlsVersion;
  epoch: number;
  sequenceNumber: bigint; // 48-bit
  fragment: Buffer;
}
