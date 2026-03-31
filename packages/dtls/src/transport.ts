// DTLS 1.2 Transport (RFC 6347)
// Implements client and server handshake state machines.

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';

import {
  ContentType,
  type DtlsRecord,
  DTLS_VERSION_1_2,
} from './types.js';
import { encodeRecord, decodeRecords, makeRecord } from './record.js';
import {
  HandshakeType,
  CipherSuites,
  ExtensionType,
  NamedCurve,
  SrtpProtectionProfile,
  type HandshakeMessage,
  type ClientHello,
  type ServerHello,
  type ServerKeyExchange,
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
  buildSignatureAlgorithmsExtension,
  parseSrtpProfiles,
} from './handshake.js';
import {
  prf,
  computeMasterSecret,
  expandKeyMaterial,
  exportKeyingMaterial,
  aesgcmEncrypt,
  aesgcmDecrypt,
  generateEcdhKeyPair,
  computeEcdhPreMasterSecret,
  encodeEcPublicKey,
  ecdsaSign,
  ecdsaVerify,
  sha256,
  hmacSha256,
} from './crypto.js';
import {
  type DtlsCertificate,
  generateSelfSignedCertificate,
  verifyFingerprint,
  extractPublicKeyFromCert,
} from './certificate.js';
import { DtlsState, type HandshakeContext, type CipherState } from './state.js';

export { DtlsState };
export type { DtlsCertificate };

export interface SrtpKeyingMaterial {
  clientKey: Buffer; // 16 bytes
  clientSalt: Buffer; // 14 bytes
  serverKey: Buffer; // 16 bytes
  serverSalt: Buffer; // 14 bytes
  profile: number; // SRTP_AES128_CM_SHA1_80 = 0x0001
}

export interface DtlsTransportOptions {
  role: 'client' | 'server';
  remoteFingerprint?: { algorithm: string; value: string };
  certificate?: DtlsCertificate;
  mtu?: number;
}

// Signature algorithm identifiers (RFC 5246 Section 7.4.1.4.1)
const SIG_HASH_SHA256 = 4;
const SIG_ALG_ECDSA = 3;
const NAMED_CURVE_P256 = 23;

export declare interface DtlsTransport {
  on(event: 'connected', listener: (srtpKeys: SrtpKeyingMaterial) => void): this;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}

export class DtlsTransport extends EventEmitter {
  readonly localCertificate: DtlsCertificate;

  private _state: DtlsState = DtlsState.New;
  private readonly role: 'client' | 'server';
  private readonly remoteFingerprint: { algorithm: string; value: string } | undefined;
  private readonly _mtu: number;

  private sendCb: ((data: Buffer) => void) | undefined;
  private _startResolve: ((keys: SrtpKeyingMaterial) => void) | undefined;
  private _startReject: ((err: Error) => void) | undefined;

  private ctx: HandshakeContext = {
    messages: [],
    sendMessageSeq: 0,
    recvMessageSeq: 0,
  };

  private cipherState: CipherState | undefined;
  private writeEpoch = 0;
  private writeSeq = 0n;
  private srtpKeys: SrtpKeyingMaterial | undefined;
  private readonly _cookieSecret = crypto.randomBytes(32);

  constructor(options: DtlsTransportOptions) {
    super();
    this.role = options.role;
    this.remoteFingerprint = options.remoteFingerprint;
    this._mtu = options.mtu ?? 1200;
    this.localCertificate = options.certificate ?? generateSelfSignedCertificate();
  }

  getState(): DtlsState {
    return this._state;
  }

  getLocalFingerprint(): { algorithm: 'sha-256'; value: string } {
    return this.localCertificate.fingerprint;
  }

  setSendCallback(cb: (data: Buffer) => void): void {
    this.sendCb = cb;
  }

  async start(): Promise<SrtpKeyingMaterial> {
    if (this._state !== DtlsState.New) {
      throw new Error('DtlsTransport already started');
    }
    this._state = DtlsState.Connecting;

    return new Promise<SrtpKeyingMaterial>((resolve, reject) => {
      this._startResolve = resolve;
      this._startReject = reject;
      if (this.role === 'client') {
        this._sendClientHello(Buffer.alloc(0)).catch((e: unknown) =>
          this._fail(e instanceof Error ? e : new Error(String(e))),
        );
      }
    });
  }

  handleIncoming(data: Buffer): void {
    if (this._state === DtlsState.Closed || this._state === DtlsState.Failed) return;
    try {
      const records = decodeRecords(data);
      for (const record of records) {
        this._processRecord(record);
      }
    } catch (e: unknown) {
      this._fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Maximum plaintext payload per DTLS record (RFC 6347 §4.1.1 limits to 2^14-1)
  private static readonly MAX_RECORD_PLAINTEXT = 16383;

  send(data: Buffer): void {
    if (this._state !== DtlsState.Connected || !this.cipherState) {
      throw new Error('DTLS not connected');
    }
    // Fragment large payloads into individual DTLS records
    const maxLen = DtlsTransport.MAX_RECORD_PLAINTEXT;
    if (data.length <= maxLen) {
      this._transmit(this._encryptRecord(ContentType.ApplicationData, data));
    } else {
      let offset = 0;
      while (offset < data.length) {
        const end = Math.min(offset + maxLen, data.length);
        this._transmit(this._encryptRecord(ContentType.ApplicationData, data.subarray(offset, end)));
        offset = end;
      }
    }
  }

  close(): void {
    if (this._state === DtlsState.Closed) return;
    try {
      const alert = Buffer.from([0x01, 0x00]);
      this._transmit(encodeRecord(makeRecord(ContentType.Alert, this.writeEpoch, this.writeSeq++, alert)));
    } catch { /* ignore */ }
    this._state = DtlsState.Closed;
    this.emit('close');
  }

  // ── Record dispatch ──────────────────────────────────────────────────────────

  private _processRecord(record: DtlsRecord): void {
    switch (record.contentType) {
      case ContentType.Handshake:      this._processHandshakeRecord(record); break;
      case ContentType.ChangeCipherSpec: this._processChangeCipherSpec(); break;
      case ContentType.ApplicationData: this._processApplicationData(record); break;
      case ContentType.Alert:           this._processAlert(record); break;
    }
  }

  private _processHandshakeRecord(record: DtlsRecord): void {
    let fragment: Buffer;
    try {
      fragment =
        record.epoch > 0 && this.cipherState
          ? this._decryptRecord(record)
          : record.fragment;
    } catch {
      return; // ignore undecryptable records
    }

    let off = 0;
    while (off < fragment.length) {
      if (fragment.length - off < 12) break;
      const preFragLen =
        (fragment[off + 9]! << 16) |
        (fragment[off + 10]! << 8) |
        fragment[off + 11]!;
      if (off + 12 + preFragLen > fragment.length) break;

      const msg = decodeHandshakeMessage(fragment.subarray(off));
      const msgSize = 12 + msg.fragmentLength;

      // Add to transcript BEFORE processing (so peer's Finished is included)
      this.ctx.messages.push(Buffer.from(fragment.subarray(off, off + msgSize)));
      off += msgSize;

      this._processHandshakeMessage(msg);
      if (this._state === DtlsState.Failed) return;
    }
  }

  private _processHandshakeMessage(msg: HandshakeMessage): void {
    if (this.role === 'client') {
      this._processAsClient(msg);
    } else {
      this._processAsServer(msg);
    }
  }

  // ── Client state machine ─────────────────────────────────────────────────────

  private _processAsClient(msg: HandshakeMessage): void {
    console.log(`[DTLS client] recv msgType=${msg.msgType}`);
    switch (msg.msgType) {
      case HandshakeType.HelloVerifyRequest: {
        const hvr = decodeHelloVerifyRequest(msg.body);
        // RFC 6347 §4.2.1: reset transcript/seqs before retrying
        this.ctx.messages = [];
        this.ctx.sendMessageSeq = 0;
        this.ctx.recvMessageSeq = 0;
        this._sendClientHello(hvr.cookie).catch((e: unknown) =>
          this._fail(e instanceof Error ? e : new Error(String(e))),
        );
        break;
      }
      case HandshakeType.ServerHello: {
        this.ctx.selectedCipherSuite = decodeServerHello(msg.body).cipherSuite;
        this.ctx.serverRandom = Buffer.from(msg.body.subarray(2, 34));
        break;
      }
      case HandshakeType.Certificate: {
        const certs = decodeCertificate(msg.body);
        const first = certs[0];
        if (!first) { this._fail(new Error('No certificate')); return; }
        this.ctx.peerCertDer = first;
        if (this.remoteFingerprint && !verifyFingerprint(first, this.remoteFingerprint)) {
          this._fail(new Error('Certificate fingerprint mismatch'));
        }
        break;
      }
      case HandshakeType.ServerKeyExchange: {
        const ske = decodeServerKeyExchange(msg.body);
        if (this.ctx.peerCertDer) {
          const peerPk = extractPublicKeyFromCert(this.ctx.peerCertDer);
          const toVerify = Buffer.concat([
            this.ctx.clientRandom ?? Buffer.alloc(32),
            this.ctx.serverRandom ?? Buffer.alloc(32),
            Buffer.from([ske.curveType]),
            Buffer.from([(ske.namedCurve >> 8) & 0xff, ske.namedCurve & 0xff]),
            Buffer.from([ske.publicKey.length]),
            ske.publicKey,
          ]);
          if (!ecdsaVerify(peerPk, toVerify, ske.signature)) {
            this._fail(new Error('ServerKeyExchange signature verification failed'));
            return;
          }
        }
        this.ctx.peerEcPublicKeyBytes = ske.publicKey;
        break;
      }
      case HandshakeType.CertificateRequest:
        // Server requested client certificate (WebRTC mutual auth).
        // Just note it — we'll send our cert in _sendClientKeyExchange.
        this.ctx.certificateRequested = true;
        break;
      case HandshakeType.ServerHelloDone:
        this._sendClientKeyExchange().catch((e: unknown) =>
          this._fail(e instanceof Error ? e : new Error(String(e))),
        );
        break;
      case HandshakeType.Finished:
        this._processServerFinished(msg.body);
        break;
    }
  }

  // ── Server state machine ─────────────────────────────────────────────────────

  private _processAsServer(msg: HandshakeMessage): void {
    console.log(`[DTLS server] received msgType=${msg.msgType} seq=${msg.messageSeq}`);
    switch (msg.msgType) {
      case HandshakeType.ClientHello: {
        const ch = decodeClientHello(msg.body);
        if (ch.cookie.length === 0) {
          // First ClientHello: send HVR, reset transcript
          const cookie = this._generateCookie(ch.random);
          this.ctx.cookie = cookie;
          this.ctx.messages = [];
          this.ctx.sendMessageSeq = 0;
          this.ctx.recvMessageSeq = 0;
          this._transmitHelloVerifyRequest(cookie);
        } else {
          // Second ClientHello with cookie
          if (this.ctx.cookie && !ch.cookie.equals(this.ctx.cookie)) {
            this._fail(new Error('Invalid DTLS cookie'));
            return;
          }
          this.ctx.clientRandom = Buffer.from(ch.random);
          this._sendServerFlight(ch).catch((e: unknown) =>
            this._fail(e instanceof Error ? e : new Error(String(e))),
          );
        }
        break;
      }
      case HandshakeType.ClientKeyExchange: {
        const cke = decodeClientKeyExchange(msg.body);
        this.ctx.peerEcPublicKeyBytes = cke.publicKey;
        if (this.ctx.ecdhPrivateKey && cke.publicKey) {
          this.ctx.preMasterSecret = computeEcdhPreMasterSecret(
            this.ctx.ecdhPrivateKey,
            cke.publicKey,
          );
        }
        break;
      }
      case HandshakeType.Finished:
        this._processClientFinished(msg.body);
        break;
    }
  }

  // ── Client sends ─────────────────────────────────────────────────────────────

  private async _sendClientHello(cookie: Buffer): Promise<void> {
    const ecdh = generateEcdhKeyPair();
    this.ctx.ecdhPrivateKey = ecdh.privateKey;
    this.ctx.ecdhPublicKey = ecdh.publicKey;
    const clientRandom = crypto.randomBytes(32);
    this.ctx.clientRandom = clientRandom;

    const hello: ClientHello = {
      clientVersion: DTLS_VERSION_1_2,
      random: clientRandom,
      sessionId: Buffer.alloc(0),
      cookie,
      cipherSuites: [
        CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        CipherSuites.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
      ],
      compressionMethods: [0],
      extensions: [
        { type: ExtensionType.UseSrtp, data: buildUseSrtpExtension([SrtpProtectionProfile.SRTP_AES128_CM_SHA1_80, SrtpProtectionProfile.SRTP_AES128_CM_SHA1_32]) },
        { type: ExtensionType.SupportedGroups, data: buildSupportedGroupsExtension([NamedCurve.secp256r1]) },
        { type: ExtensionType.SignatureAlgorithms, data: buildSignatureAlgorithmsExtension([{ hash: SIG_HASH_SHA256, sig: SIG_ALG_ECDSA }]) },
      ],
    };
    const body = encodeClientHello(hello);
    const seq = this.ctx.sendMessageSeq++;
    this._sendHandshake({ msgType: HandshakeType.ClientHello, length: body.length, messageSeq: seq, fragmentOffset: 0, fragmentLength: body.length, body });
  }

  private async _sendClientKeyExchange(): Promise<void> {
    if (!this.ctx.ecdhPrivateKey || !this.ctx.ecdhPublicKey || !this.ctx.peerEcPublicKeyBytes) {
      this._fail(new Error('Missing ECDH keys for ClientKeyExchange'));
      return;
    }
    this.ctx.preMasterSecret = computeEcdhPreMasterSecret(
      this.ctx.ecdhPrivateKey,
      this.ctx.peerEcPublicKeyBytes,
    );

    // If server requested client certificate, send it before ClientKeyExchange
    if (this.ctx.certificateRequested) {
      console.log('[DTLS client] sending Certificate + CertificateVerify (mutual auth)');
      this._sendHandshakeBody(HandshakeType.Certificate, encodeCertificate(this.localCertificate.cert));
    }

    const myPkBytes = encodeEcPublicKey(this.ctx.ecdhPublicKey);
    this._sendHandshakeBody(HandshakeType.ClientKeyExchange, encodeClientKeyExchange({ publicKey: myPkBytes }));

    // If server requested client certificate, send CertificateVerify
    if (this.ctx.certificateRequested) {
      // RFC 5246 §7.4.8: sign Hash(handshake_messages) with client's private key.
      // ecdsaSign uses crypto.sign('sha256',...) which internally hashes the data,
      // so we pass the raw transcript (NOT pre-hashed).
      const transcript = Buffer.concat(this.ctx.messages);
      const sig = ecdsaSign(this.localCertificate.privateKey, transcript);
      // CertificateVerify body: 2 bytes sig algorithm + 2 bytes sig length + sig
      const cvBody = Buffer.alloc(4 + sig.length);
      cvBody.writeUInt8(SIG_HASH_SHA256, 0);  // hash algorithm
      cvBody.writeUInt8(SIG_ALG_ECDSA, 1);    // signature algorithm
      cvBody.writeUInt16BE(sig.length, 2);
      sig.copy(cvBody, 4);
      this._sendHandshakeBody(HandshakeType.CertificateVerify, cvBody);
    }

    this._deriveKeys();
    this._sendChangeCipherSpec();
    this._sendFinished();
  }

  // ── Server sends ─────────────────────────────────────────────────────────────

  /**
   * Transmit HelloVerifyRequest WITHOUT adding it to the transcript.
   * RFC 6347 §4.2.1: HVR is excluded from the handshake hash.
   */
  private _transmitHelloVerifyRequest(cookie: Buffer): void {
    const hvr = encodeHelloVerifyRequest({ serverVersion: DTLS_VERSION_1_2, cookie });
    const seq = this.ctx.sendMessageSeq++;
    const hsBuf = encodeHandshakeMessage({
      msgType: HandshakeType.HelloVerifyRequest,
      length: hvr.length,
      messageSeq: seq,
      fragmentOffset: 0,
      fragmentLength: hvr.length,
      body: hvr,
    });
    this._transmit(encodeRecord(makeRecord(ContentType.Handshake, this.writeEpoch, this.writeSeq++, hsBuf)));
    // NOT added to this.ctx.messages
  }

  private async _sendServerFlight(clientHello: ClientHello): Promise<void> {
    const serverRandom = crypto.randomBytes(32);
    this.ctx.serverRandom = serverRandom;

    const supported: number[] = [
      CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
      CipherSuites.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
    ];
    const cipherSuite =
      clientHello.cipherSuites.find((cs) => supported.includes(cs)) ??
      CipherSuites.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256;
    this.ctx.selectedCipherSuite = cipherSuite;

    const serverHelloExts: Array<{ type: number; data: Buffer }> = [];
    const srtpExt = clientHello.extensions.find((e) => e.type === ExtensionType.UseSrtp);
    if (srtpExt) {
      const profiles = parseSrtpProfiles(srtpExt.data);
      const profile =
        profiles.find((p) => p === SrtpProtectionProfile.SRTP_AES128_CM_SHA1_80) ??
        profiles[0] ??
        SrtpProtectionProfile.SRTP_AES128_CM_SHA1_80;
      serverHelloExts.push({ type: ExtensionType.UseSrtp, data: buildUseSrtpExtension([profile]) });
    }

    const sh: ServerHello = {
      serverVersion: DTLS_VERSION_1_2,
      random: serverRandom,
      sessionId: Buffer.alloc(0),
      cipherSuite,
      compressionMethod: 0,
      extensions: serverHelloExts,
    };
    this._sendHandshakeBody(HandshakeType.ServerHello, encodeServerHello(sh));
    this._sendHandshakeBody(HandshakeType.Certificate, encodeCertificate(this.localCertificate.cert));

    const ecdhPair = generateEcdhKeyPair();
    this.ctx.ecdhPrivateKey = ecdhPair.privateKey;
    this.ctx.ecdhPublicKey = ecdhPair.publicKey;
    const serverEcPk = encodeEcPublicKey(ecdhPair.publicKey);

    const clientRandom = this.ctx.clientRandom ?? Buffer.alloc(32);
    const toSign = Buffer.concat([
      clientRandom, serverRandom,
      Buffer.from([3]),
      Buffer.from([(NAMED_CURVE_P256 >> 8) & 0xff, NAMED_CURVE_P256 & 0xff]),
      Buffer.from([serverEcPk.length]),
      serverEcPk,
    ]);
    const sig = ecdsaSign(this.localCertificate.privateKey, toSign);

    const ske: ServerKeyExchange = {
      curveType: 3,
      namedCurve: NAMED_CURVE_P256,
      publicKey: serverEcPk,
      signatureAlgorithm: { hash: SIG_HASH_SHA256, signature: SIG_ALG_ECDSA },
      signature: sig,
    };
    this._sendHandshakeBody(HandshakeType.ServerKeyExchange, encodeServerKeyExchange(ske));
    this._sendHandshakeBody(HandshakeType.ServerHelloDone, Buffer.alloc(0));
  }

  // ── Key derivation ───────────────────────────────────────────────────────────

  private _deriveKeys(): void {
    const cr = this.ctx.clientRandom ?? Buffer.alloc(32);
    const sr = this.ctx.serverRandom ?? Buffer.alloc(32);
    if (!this.ctx.preMasterSecret) throw new Error('No pre-master secret');

    const ms = computeMasterSecret(this.ctx.preMasterSecret, cr, sr);
    const kb = expandKeyMaterial(ms, cr, sr, 16, 4);

    this.cipherState = {
      writeKey: this.role === 'client' ? kb.clientWriteKey : kb.serverWriteKey,
      writeIv:  this.role === 'client' ? kb.clientWriteIv  : kb.serverWriteIv,
      readKey:  this.role === 'client' ? kb.serverWriteKey : kb.clientWriteKey,
      readIv:   this.role === 'client' ? kb.serverWriteIv  : kb.clientWriteIv,
      writeEpoch: 1, writeSeq: 0n,
      readEpoch:  1, readSeq:  0n,
    };

    const srtpMat = exportKeyingMaterial(ms, cr, sr, 'EXTRACTOR-dtls_srtp', 60);
    this.srtpKeys = {
      clientKey:  Buffer.from(srtpMat.subarray(0, 16)),
      serverKey:  Buffer.from(srtpMat.subarray(16, 32)),
      clientSalt: Buffer.from(srtpMat.subarray(32, 46)),
      serverSalt: Buffer.from(srtpMat.subarray(46, 60)),
      profile: SrtpProtectionProfile.SRTP_AES128_CM_SHA1_80,
    };
  }

  // ── ChangeCipherSpec / Finished ──────────────────────────────────────────────

  private _sendChangeCipherSpec(): void {
    this._transmit(encodeRecord(makeRecord(ContentType.ChangeCipherSpec, this.writeEpoch, this.writeSeq++, Buffer.from([1]))));
    this.writeEpoch = 1;
    this.writeSeq = 0n;
  }

  private _processChangeCipherSpec(): void {
    // When server receives client's CCS, derive keys if not done yet
    if (!this.cipherState && this.ctx.preMasterSecret) {
      this._deriveKeys();
    }
  }

  private _computeFinished(role: 'client' | 'server'): Buffer {
    const cr = this.ctx.clientRandom ?? Buffer.alloc(32);
    const sr = this.ctx.serverRandom ?? Buffer.alloc(32);
    if (!this.ctx.preMasterSecret) throw new Error('No pre-master secret');
    const ms = computeMasterSecret(this.ctx.preMasterSecret, cr, sr);
    const hash = crypto.createHash('sha256').update(Buffer.concat(this.ctx.messages)).digest();
    return prf(ms, role === 'client' ? 'client finished' : 'server finished', hash as Buffer, 12);
  }

  private _computePeerFinished(peerRole: 'client' | 'server'): Buffer {
    const cr = this.ctx.clientRandom ?? Buffer.alloc(32);
    const sr = this.ctx.serverRandom ?? Buffer.alloc(32);
    if (!this.ctx.preMasterSecret) throw new Error('No pre-master secret');
    const ms = computeMasterSecret(this.ctx.preMasterSecret, cr, sr);
    // Exclude the peer's Finished message (the last one added) from the transcript
    const msgs = this.ctx.messages.slice(0, -1);
    const hash = crypto.createHash('sha256').update(Buffer.concat(msgs)).digest();
    return prf(ms, peerRole === 'client' ? 'client finished' : 'server finished', hash as Buffer, 12);
  }

  private _sendFinished(): void {
    const verifyData = this._computeFinished(this.role);
    const hsBuf = this._buildHandshakeMessage(HandshakeType.Finished, verifyData);
    this._transmit(this._encryptRecord(ContentType.Handshake, hsBuf));
    // Add our own Finished to transcript AFTER computing verify_data
    this.ctx.messages.push(hsBuf);
  }

  private _processServerFinished(body: Buffer): void {
    const expected = this._computePeerFinished('server');
    if (!body.equals(expected)) {
      this._fail(new Error('Server Finished verification failed'));
      return;
    }
    this._state = DtlsState.Connected;
    if (this.srtpKeys) {
      this._startResolve?.(this.srtpKeys);
      this.emit('connected', this.srtpKeys);
    }
  }

  private _processClientFinished(body: Buffer): void {
    // Derive keys if CCS was not received first
    if (!this.cipherState && this.ctx.preMasterSecret) {
      this._deriveKeys();
    }
    const expected = this._computePeerFinished('client');
    if (!body.equals(expected)) {
      this._fail(new Error('Client Finished verification failed'));
      return;
    }
    this._sendChangeCipherSpec();
    this._sendFinished();
    this._state = DtlsState.Connected;
    if (this.srtpKeys) {
      this._startResolve?.(this.srtpKeys);
      this.emit('connected', this.srtpKeys);
    }
  }

  // ── Application data / Alerts ────────────────────────────────────────────────

  private _processApplicationData(record: DtlsRecord): void {
    if (!this.cipherState) return;
    try {
      const decrypted = this._decryptRecord(record);
      this.emit('data', decrypted);
    } catch (e: unknown) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
    }
  }

  private _processAlert(record: DtlsRecord): void {
    if (record.fragment.length >= 2 && record.fragment[1] === 0) {
      this._state = DtlsState.Closed;
      this.emit('close');
    }
  }

  // ── AES-128-GCM ──────────────────────────────────────────────────────────────

  private _encryptRecord(contentType: ContentType, plaintext: Buffer): Buffer {
    if (!this.cipherState) throw new Error('No cipher state');
    const epoch = this.cipherState.writeEpoch;
    const seq = this.cipherState.writeSeq++;
    const explicit = seqBuf8(seq);
    const nonce = Buffer.concat([this.cipherState.writeIv, explicit]);
    const aad = buildAad(epoch, seq, contentType, plaintext.length);
    const { ciphertext, tag } = aesgcmEncrypt(this.cipherState.writeKey, nonce, plaintext, aad);
    return encodeRecord(makeRecord(contentType, epoch, seq, Buffer.concat([explicit, ciphertext, tag])));
  }

  private _decryptRecord(record: DtlsRecord): Buffer {
    if (!this.cipherState) throw new Error('No cipher state');
    const f = record.fragment;
    if (f.length < 24) throw new Error('Encrypted record too short');
    const explicit = f.subarray(0, 8);
    const ciphertext = f.subarray(8, f.length - 16);
    const tag = f.subarray(f.length - 16);
    const nonce = Buffer.concat([this.cipherState.readIv, explicit]);
    const aad = buildAad(record.epoch, record.sequenceNumber, record.contentType, ciphertext.length);
    return aesgcmDecrypt(this.cipherState.readKey, nonce, ciphertext, tag, aad);
  }

  // ── Handshake helpers ────────────────────────────────────────────────────────

  private _buildHandshakeMessage(msgType: HandshakeType, body: Buffer): Buffer {
    return encodeHandshakeMessage({
      msgType, length: body.length,
      messageSeq: this.ctx.sendMessageSeq++,
      fragmentOffset: 0, fragmentLength: body.length, body,
    });
  }

  private _sendHandshakeBody(msgType: HandshakeType, body: Buffer): void {
    const hsBuf = this._buildHandshakeMessage(msgType, body);
    this.ctx.messages.push(hsBuf);
    this._transmit(encodeRecord(makeRecord(ContentType.Handshake, this.writeEpoch, this.writeSeq++, hsBuf)));
  }

  private _sendHandshake(msg: HandshakeMessage): void {
    const hsBuf = encodeHandshakeMessage(msg);
    this.ctx.messages.push(hsBuf);
    this._transmit(encodeRecord(makeRecord(ContentType.Handshake, this.writeEpoch, this.writeSeq++, hsBuf)));
  }

  // ── Cookie ───────────────────────────────────────────────────────────────────

  private _generateCookie(clientRandom: Buffer): Buffer {
    return hmacSha256(this._cookieSecret, clientRandom).subarray(0, 20);
  }

  // ── Transmit / Fail ──────────────────────────────────────────────────────────

  private _transmit(data: Buffer): void {
    this.sendCb?.(data);
  }

  private _fail(err: Error): void {
    if (this._state === DtlsState.Failed || this._state === DtlsState.Closed) return;
    this._state = DtlsState.Failed;
    this._startReject?.(err);
    this.emit('error', err);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function seqBuf8(seq: bigint): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeUInt32BE(Number((seq >> 32n) & 0xffffffffn), 0);
  b.writeUInt32BE(Number(seq & 0xffffffffn), 4);
  return b;
}

function buildAad(epoch: number, seq: bigint, ct: ContentType, len: number): Buffer {
  const aad = Buffer.allocUnsafe(13);
  aad.writeUInt16BE(epoch, 0);
  aad.writeUInt16BE(Number((seq >> 32n) & 0xffffn), 2);
  aad.writeUInt32BE(Number(seq & 0xffffffffn), 4);
  aad.writeUInt8(ct, 8);
  aad.writeUInt8(DTLS_VERSION_1_2.major, 9);
  aad.writeUInt8(DTLS_VERSION_1_2.minor, 10);
  aad.writeUInt16BE(len, 11);
  return aad;
}
