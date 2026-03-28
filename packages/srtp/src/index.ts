// Public API – re-export everything from the srtp package.

export { ProtectionProfile } from './types.js';
export type { SrtpKeyingMaterial, SrtpContext, SrtcpContext } from './types.js';

export { createSrtpContext, createSrtcpContext, deriveSessionKey } from './context.js';

export { aes128cmKeystream, computeSrtpIv, computeSrtcpIv } from './cipher.js';

export { computeSrtpAuthTag, computeSrtcpAuthTag } from './auth.js';

export { gcmSrtpProtect, gcmSrtpUnprotect } from './gcm.js';

export { ReplayWindow } from './replay.js';

export { srtpProtect, srtcpProtect } from './protect.js';

export { srtpUnprotect, srtcpUnprotect } from './unprotect.js';
