// @agentdance/node-webrtc-dtls – DTLS 1.2 implementation
// Public API

export { ContentType, DTLS_VERSION_1_2, type DtlsRecord, type DtlsVersion } from './types.js';
export {
  encodeRecord,
  decodeRecords,
  isDtlsPacket,
  makeRecord,
} from './record.js';
export {
  HandshakeType,
  CipherSuites,
  ExtensionType,
  NamedCurve,
  SrtpProtectionProfile,
  type HandshakeMessage,
  type ClientHello,
  type ServerHello,
  type HelloVerifyRequest,
  type ServerKeyExchange,
  type ClientKeyExchange,
  type TlsExtension,
  encodeHandshakeMessage,
  decodeHandshakeMessage,
  encodeClientHello,
  decodeClientHello,
  encodeServerHello,
  decodeServerHello,
  encodeHelloVerifyRequest,
  decodeHelloVerifyRequest,
  encodeCertificate,
  decodeCertificate,
  encodeServerKeyExchange,
  decodeServerKeyExchange,
  encodeClientKeyExchange,
  decodeClientKeyExchange,
  buildUseSrtpExtension,
  buildSupportedGroupsExtension,
} from './handshake.js';
export {
  prf,
  hmacSha256,
  computeMasterSecret,
  expandKeyMaterial,
  exportKeyingMaterial,
  aesgcmEncrypt,
  aesgcmDecrypt,
  generateEcdhKeyPair,
  computeEcdhPreMasterSecret,
  encodeEcPublicKey,
  decodeEcPublicKey,
  ecdsaSign,
  ecdsaVerify,
  sha256,
  type AesGcmResult,
  type EcdhKeyPair,
  type KeyBlock,
} from './crypto.js';
export {
  type DtlsCertificate,
  generateSelfSignedCertificate,
  computeFingerprint,
  verifyFingerprint,
  extractPublicKeyFromCert,
} from './certificate.js';
export { DtlsState, type SecurityParameters, type HandshakeContext, type CipherState } from './state.js';
export {
  DtlsTransport,
  type DtlsTransportOptions,
  type SrtpKeyingMaterial,
} from './transport.js';
