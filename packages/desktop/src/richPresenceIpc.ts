/**
 * Compatibility facade for the rich presence implementation. Keep existing
 * imports stable while the protocol, sessions, transports and lifecycle live
 * in focused modules under `richPresence/`.
 */
export {
  clampByCodepoints,
  normalizeActivity,
  resolveAssetUrl,
} from './richPresence/activityNormalizer';
export {
  OP_CLOSE,
  OP_FRAME,
  OP_HANDSHAKE,
  OP_PING,
  OP_PONG,
  encodeFrame,
  isValidClientId,
  tryDecodeFrame,
  tryParseRawJson,
  type DecodedFrame,
  type IpcActivityPayload,
  type IpcActivityPush,
  type IpcActivityType,
  type IpcAssets,
} from './richPresence/protocol';
export {
  getRichPresenceIpcStatus,
  startRichPresenceIpcServer,
  stopRichPresenceIpcServer,
  type RichPresenceIpcServerOptions,
  type RichPresenceIpcStatus,
} from './richPresence/server';
export {
  candidateSocketDirs,
  createRichPresenceTransport,
  discordNamedPipePath,
  type RichPresenceTransport,
} from './richPresence/transports';
