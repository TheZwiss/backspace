import { create } from 'zustand';
import type {
  User,
  InstanceInfoResponse,
  ReplicatedInstance,
  AuthResponse,
  FederationRegistryEntry,
  FederationRegistryStatus,
} from '@backspace/shared';
import { BackspaceApiClient, HttpError, createApiClient, api } from '../api/client';
import { useAuthStore } from './authStore';
import {
  setApiForOriginResolver,
  setUserIdForOriginResolver,
  setOriginFromHostnameResolver,
  setTokenForOriginResolver,
} from '../utils/crossStoreResolvers';
import { useSpaceStore } from './spaceStore';
import { connectInstance, disconnectInstance as disconnectWs, disconnectAllRemote } from '../hooks/useWebSocket';
// dmOriginFailover lazily reads useInstanceStore/useSpaceStore/useChatStore at call time,
// so a static import here does not create an import-time cycle.
import { failoverDmOriginsFromDisconnected } from '../utils/dmOriginFailover';
import { useUIStore } from './uiStore';
import { parseFederatedUsername } from '../utils/identity';
// The registry's `errorMessage` carries one of these codes, never a sentence:
// the Connections row is what turns it into words, in the user's language.
import { registryReason } from '../i18n/registryErrors';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConnectedInstance {
  origin: string;
  label: string;
  token: string;
  user: User;
  username: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
  api: BackspaceApiClient;
}

interface CachedInstanceToken {
  token: string;
  label: string;
  username: string;
}

const STORAGE_KEY_PREFIX = 'backspace_instances';
const LEGACY_STORAGE_KEY = 'backspace_instances';

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}_${userId}`;
}

// ─── localStorage helpers ────────────────────────────────────────────────────

function loadCachedTokens(userId: string): Record<string, CachedInstanceToken> {
  try {
    const scopedKey = storageKey(userId);
    const raw = localStorage.getItem(scopedKey);
    if (raw) {
      return JSON.parse(raw) as Record<string, CachedInstanceToken>;
    }

    // One-time migration: adopt legacy unscoped key if it exists
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, CachedInstanceToken>;
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return parsed;
    }

    return {};
  } catch {
    return {};
  }
}

function saveCachedTokens(instances: ConnectedInstance[], userId: string): void {
  const cache: Record<string, CachedInstanceToken> = {};
  for (const inst of instances) {
    // Skip tokenless placeholders — writing an empty token would cause
    // autoConnectAll to find a truthy cached entry with an empty bearer token
    if (!inst.token) continue;
    cache[inst.origin] = {
      token: inst.token,
      label: inst.label,
      username: inst.username,
    };
  }
  localStorage.setItem(storageKey(userId), JSON.stringify(cache));
}

// ─── Network error detection ────────────────────────────────────────────────

/** Detect network-level failures (unreachable, DNS, timeout) vs application errors (401, etc.) */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError ||
    (err instanceof Error && /fetch|network|ECONNREFUSED|ETIMEDOUT/i.test(err.message));
}

// ─── Error types ────────────────────────────────────────────────────────────

/**
 * Thrown when the instance already has an account for this user and it does
 * not accept the credential the home instance issued for it: the account
 * predates per-remote credentials, or was made by hand there. The way out is
 * the explicit per-instance login, so every surface that can offer it catches
 * this class by name.
 *
 * It is an `HttpError` carrying a registered code, minted by the client
 * rather than by a route, so `describeError` says it in the user's language
 * wherever it does escape to a message. The English text stays as the log
 * line and the last-resort fallback, never as what a Russian or German user
 * reads.
 */
export class DifferentPasswordError extends HttpError {
  constructor(public remoteUsername: string) {
    super(
      409,
      'Account exists with a different password on this instance',
      { error: 'federation_different_password', code: 'federation_different_password', statusCode: 409 },
      'federation_different_password',
    );
    this.name = 'DifferentPasswordError';
  }
}

// ─── URL normalization ───────────────────────────────────────────────────────

/**
 * Canonical origin of a user-typed or stored instance value: scheme added
 * when missing, host lowercased, path and trailing slash dropped. Throws
 * `Invalid URL` when the value does not parse.
 */
export function normalizeOrigin(url: string): string {
  let normalized = url.trim();

  // Add https:// if no protocol
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.origin; // "https://domain.com" — no path, no trailing slash
  } catch {
    throw new Error('Invalid URL');
  }
}

/** Check whether an origin string refers to the current (home) instance. */
export function isSelfOrigin(origin: string): boolean {
  try {
    return normalizeOrigin(origin) === window.location.origin;
  } catch {
    return false;
  }
}

// ─── Home-session resolution ─────────────────────────────────────────────────

/** Bare, lowercased hostname of an origin / homeInstance value (no scheme, no port). */
function homeHostOf(value: string): string {
  const stripped = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return (stripped.split('/')[0] ?? '').split(':')[0]!.toLowerCase();
}

/**
 * The authenticated API client for a given home domain, or null when this
 * client holds no session there: the primary connection when we are browsing
 * that domain natively, else a connected secondary instance.
 *
 * Shared by `maybeAutoReattach` (proof minting) and `resolveCredentialHomeApi`
 * (per-remote credential issuance) so both agree on what "a session on the home
 * instance" means.
 */
function resolveSessionApiForHome(homeDomain: string): { api: BackspaceApiClient; username: string } | null {
  const primaryUser = useAuthStore.getState().user;
  if (primaryUser && !primaryUser.homeInstance && window.location.hostname.toLowerCase() === homeDomain) {
    return { api, username: primaryUser.username };
  }
  const conn = useInstanceStore.getState().instances.find(
    (i) => i.status === 'connected' && new URL(i.origin).hostname.toLowerCase() === homeDomain,
  );
  return conn ? { api: conn.api, username: conn.username } : null;
}

/**
 * The API client of the instance that ISSUES this account's per-remote
 * federation credentials — always the account's true home.
 *
 * Credentials must be minted in exactly one place. If each browsing instance
 * issued its own, the same remote account would be handed two different secrets
 * and the user would be locked out of it from every device but one. A detached
 * account (`federationHomeOrphaned`) has no home left to ask, so it is sovereign
 * here and issues its own — the same rule the server applies (users.ts).
 */
function resolveCredentialHomeApi(): BackspaceApiClient | null {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser) return null;
  if (!currentUser.homeInstance || currentUser.federationHomeOrphaned) return api;
  return resolveSessionApiForHome(homeHostOf(currentUser.homeInstance))?.api ?? null;
}

/**
 * Make the remote account for THIS user on `instance` authenticate with the
 * home-issued per-remote secret rather than whatever it was provisioned with.
 *
 * This is the single place that reconciles a remote account's credential, so
 * every path that establishes a remote session routes through it: fresh
 * connect, explicit login, and token reconnect. Connections made before
 * per-remote secrets existed still carry `bcrypt(home password)`; the home
 * instance's `provisioned` flag marks which ones have been migrated, so the
 * rotation happens exactly once per account instead of on every launch (each
 * rotation bumps the remote's `passwordChangedAt` and revokes this user's other
 * sessions there).
 *
 * `force` skips the flag — used after an explicit login, which is the one
 * signal that the remote hash is something other than the issued secret.
 *
 * Never touches an account that is not this user's federated identity on that
 * instance: `homeInstance` and `homeUserId` must both match, so a native
 * account someone logged into on the remote is left alone.
 */
export async function ensureRemoteCredential(
  instance: ConnectedInstance,
  opts: { force?: boolean } = {},
): Promise<void> {
  const currentUser = useAuthStore.getState().user;
  if (!currentUser) return;

  const trueHomeHost = homeHostOf(currentUser.homeInstance ?? window.location.host);
  if (homeHostOf(instance.origin) === trueHomeHost) return; // home keeps the real password

  const remote = instance.user;
  if (!remote.homeInstance || !remote.homeUserId) return;
  if (homeHostOf(remote.homeInstance) !== trueHomeHost) return;
  if (remote.homeUserId !== (currentUser.homeUserId ?? currentUser.id)) return;

  const homeApi = resolveCredentialHomeApi();
  if (!homeApi) return;

  const credential = await homeApi.users.federationCredential({ origin: instance.origin });
  if (credential.provisioned && !opts.force) return;

  const rotated = await instance.api.users.changePassword({ newPassword: credential.secret });
  useInstanceStore.getState().updateInstanceToken(instance.origin, rotated.token);
  await homeApi.users.federationCredential({ origin: instance.origin, markProvisioned: true });
}

// ─── Automatic re-attach (re-attach spec §3.4) ────────────────────────────────

/**
 * Automatic re-attach (re-attach spec §3.4): when a just-connected remote
 * account is DETACHED and this client also holds an authenticated session on
 * the account's home domain under the SAME username base, silently perform
 * the proof exchange — the user has proven both identities, so the accounts
 * re-link without interaction. Cross-name binds and every ambiguous case fall
 * through to the explicit AccountPanel action. Fire-and-forget, non-fatal.
 */
export async function maybeAutoReattach(instance: ConnectedInstance): Promise<void> {
  const remoteUser = instance.user;
  if (!remoteUser.federationHomeOrphaned || !remoteUser.homeInstance) return;
  const homeDomain = remoteUser.homeInstance.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();

  // An authenticated session on the account's home domain: the primary
  // connection when we're browsing it, else a connected secondary instance.
  const homeSession = resolveSessionApiForHome(homeDomain);
  if (!homeSession) return;
  const { api: homeApi, username: homeUsername } = homeSession;

  // Unambiguous case only: same username base on both sides (spec §2/§3.4).
  const detachedBase = parseFederatedUsername(remoteUser.username).baseName.toLowerCase();
  const homeBase = parseFederatedUsername(homeUsername).baseName.toLowerCase();
  if (!detachedBase || detachedBase !== homeBase) return;

  try {
    // Portless hostname — must match the server's extractDomain(peer.origin)
    // (new URL(origin).hostname) so the proof's targetDomain binds/verifies on
    // a non-443 port too. .host would carry the port and 401 forever.
    const targetHost = new URL(instance.origin).hostname;
    const { token } = await homeApi.auth.attachProof(targetHost);
    const res = await instance.api.users.reattach({ token });
    // Not a transition: the session stands, only the identity it is bound to
    // has changed. The registry mirrors the connection's identity, so both
    // halves take the re-bound username in the same write.
    writeConnectionState(instance.origin, null, {
      live: { user: res.user, username: res.user.username },
      registry: { username: res.user.username, remoteUserId: res.user.id },
    });
    useUIStore.getState().addToast(`Account re-linked with ${homeDomain}`, 'success');
    useInstanceStore.getState().syncRegistry().catch(() => {});
    // Re-attach reconciled this connection's 1-on-1 DM federatedIds (merge/re-key
    // on the server); refetch the DM list so the split conversation collapses
    // without a reload. Belt-and-suspenders for the connection that triggered it
    // — the server's dm_channel_closed/created events cover the live sidebar too.
    try { await useSpaceStore.getState().reloadDmsForOrigin(instance.origin); } catch { /* non-fatal */ }
  } catch (err) {
    // Non-fatal: the connection works either way; the explicit re-attach
    // action in AccountPanel remains available.
    console.warn('[federation] Auto re-attach failed:', err);
  }
}

// ─── Auto-connect gate ───────────────────────────────────────────────────────

/**
 * Resolve once `autoConnectAll` has finished, so a fan-out over connected
 * instances does not run against an incomplete or empty list on page reload.
 * Resolves at once when it already has. The flag is re-read after subscribing
 * because it can flip between the first check and the subscription.
 */
export function waitForAutoConnect(): Promise<void> {
  if (useInstanceStore.getState()._autoConnectDone) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsub = useInstanceStore.subscribe((state) => {
      if (state._autoConnectDone) {
        unsub();
        resolve();
      }
    });
    if (useInstanceStore.getState()._autoConnectDone) {
      unsub();
      resolve();
    }
  });
}

// ─── Connection state: the one writer ────────────────────────────────────────

/**
 * A connection is held in two projections at once, and both carry a status:
 * the live `ConnectedInstance` in `instances` (token, api client, the status
 * the socket layer mirrors) and the persisted `FederationRegistryEntry` in
 * `registry` (what the Connections panel, the Explore chips and Outer Space
 * render). They are not derived from one another — components read both — so
 * they can only stay in step if one piece of code moves them together.
 *
 * `writeConnectionState` below is that piece of code. Every status change goes
 * through it, naming a phase from the table; nothing else in this file writes
 * a status to either projection, apart from `autoConnectAll` seeding a row from
 * the server registry or from localStorage, which creates the persisted record
 * for an origin that has no live half yet rather than moving one. `innerOrigins`
 * (`utils/directory.ts`) reads across the pair, so halves that disagree put an
 * instance's spaces in the wrong half of the Explore page.
 */

/**
 * The registry entry for `origin`, created from the defaults when it has none.
 * A status is required because a row is only ever created by a phase, which
 * names one: there is no default status that some phase did not choose.
 */
function upsertRegistryEntry(
  registry: Map<string, FederationRegistryEntry>,
  origin: string,
  updates: Partial<FederationRegistryEntry> & { origin: string; status: FederationRegistryStatus },
): Map<string, FederationRegistryEntry> {
  const next = new Map(registry);
  const existing = next.get(origin);
  if (existing) {
    next.set(origin, { ...existing, ...updates });
  } else {
    next.set(origin, {
      label: '',
      username: '',
      remoteUserId: '',
      addedAt: Date.now(),
      lastConnectedAt: null,
      disconnectedAt: null,
      errorMessage: null,
      ...updates,
    });
  }
  return next;
}

/** One phase: what it means on the live entry and what it records in the registry. */
interface PhaseSpec {
  /** The status the live entry takes. */
  live: ConnectedInstance['status'];
  /** The live `error` string, English, for the console. A phase without one clears it. */
  error?: string;
  /**
   * The registry half, called at write time so its timestamps are the write's.
   * Null marks a phase that is not a registry event: the entry keeps what it
   * last recorded, and a call site cannot write registry fields through it.
   */
  registry: (() => Partial<FederationRegistryEntry> & { status: FederationRegistryStatus }) | null;
}

/**
 * Every way a connection's state moves, with both halves named once.
 *
 * The `live-*` phases move the live entry alone. Socket liveness is not a
 * registry event: the registry records what the account's session with an
 * instance is worth, and a websocket that drops for thirty seconds must not
 * leave a row saying the user disconnected (which suppresses auto-connect on
 * the next launch) or that the token expired. `live-connecting` is the same
 * rule for an attempt in flight, which the registry has no status for at all.
 */
const CONNECTION_PHASES = {
  /** A session was established: a fresh connect, an explicit login, or a token reconnect. */
  connected: {
    live: 'connected',
    registry: () => ({
      status: 'connected' as const,
      lastConnectedAt: Date.now(),
      disconnectedAt: null,
      errorMessage: null,
    }),
  },
  /** The user disconnected this instance by hand. The row stays; it is what stops the next auto-connect. */
  disconnected: {
    live: 'disconnected',
    registry: () => ({
      status: 'disconnected' as const,
      disconnectedAt: Date.now(),
      errorMessage: null,
    }),
  },
  /** The instance did not answer. The token may well still be good, so the socket keeps retrying. */
  unreachable: {
    live: 'disconnected',
    error: 'Instance unreachable, retrying in background',
    registry: () => ({ status: 'unreachable' as const, errorMessage: registryReason('unreachable') }),
  },
  /** A session that existed was refused: only a password gets back in. */
  'token-expired': {
    live: 'error',
    error: 'Token expired, re-authenticate to reconnect',
    registry: () => ({ status: 'auth_expired' as const, errorMessage: registryReason('session_expired') }),
  },
  /** A known connection with no cached token at all: nothing to try, so it starts where a refused token ends. */
  'no-session': {
    live: 'error',
    error: 'Session expired, re-authenticate to reconnect',
    registry: () => ({ status: 'auth_expired' as const, errorMessage: registryReason('session_expired') }),
  },
  /** The socket came up. */
  'live-connected': { live: 'connected', registry: null },
  /** An attempt is in flight, or a cached-token placeholder is waiting for one. */
  'live-connecting': { live: 'connecting', registry: null },
  /** The socket dropped, or a placeholder stands for a row that already says disconnected. */
  'live-disconnected': { live: 'disconnected', registry: null },
  /** The socket layer reports a failure of its own. */
  'live-error': { live: 'error', registry: null },
} satisfies Record<string, PhaseSpec>;

/** A phase name, as `writeConnectionState` takes it. */
type ConnectionPhase = keyof typeof CONNECTION_PHASES;

/** Live fields a write can refresh; the status and the error are the phase's. */
type LivePatch = Partial<Omit<ConnectedInstance, 'origin' | 'status' | 'error'>>;

/** Registry fields a write can record; the status and the reason are the phase's. */
type RegistryPatch = Partial<Omit<FederationRegistryEntry, 'origin' | 'status'>>;

interface ConnectionWrite {
  /** Replaces the phase's live error string. The socket layer carries its own wording. */
  error?: string;
  /** Live fields this transition also refreshes (user, label, username). */
  live?: LivePatch;
  /** Registry fields this transition also records. Ignored by a phase with no registry half. */
  registry?: RegistryPatch;
  /**
   * The live entry for an origin the list does not hold yet: a fresh session,
   * or the cached-token placeholder `reconnectInstance` restores. It replaces
   * any entry the origin already has and goes to the end of the list, so the
   * origin is never absent between the two (client-federation.md §6, "a
   * placeholder is replaced, never removed first"). Without it, an origin with
   * no live entry moves its registry half only.
   */
  insert?: Omit<ConnectedInstance, 'status' | 'error'>;
  /**
   * The store-wide loading flag, settled in the same `set` as the entry. The
   * two connect flows are its only callers: the flag guards the form that
   * produced the connection, so it belongs to the moment the entry appears
   * rather than to a `set` after it.
   */
  isLoading?: boolean;
}

/**
 * Move a connection to `phase`, writing both projections in one `set`.
 *
 * This is the only code that writes a status to `instances` or to `registry`,
 * and the only code that stamps `registryUpdatedAt` for a state change, so the
 * two halves cannot drift the way ten hand-written pairs could. A `phase` of
 * null writes the named fields on both halves without moving either status:
 * re-attach rebinding the account's identity is such a write, not a transition.
 *
 * Returns the live entry as it now stands, or undefined when the origin has no
 * live entry and the write did not bring one.
 */
function writeConnectionState(
  origin: string,
  phase: ConnectionPhase,
  write: ConnectionWrite & { insert: Omit<ConnectedInstance, 'status' | 'error'> },
): ConnectedInstance;
function writeConnectionState(
  origin: string,
  phase: ConnectionPhase | null,
  write?: ConnectionWrite,
): ConnectedInstance | undefined;
function writeConnectionState(
  origin: string,
  phase: ConnectionPhase | null,
  write: ConnectionWrite = {},
): ConnectedInstance | undefined {
  const spec: PhaseSpec | null = phase ? CONNECTION_PHASES[phase] : null;
  const error = spec ? (write.error ?? spec.error) : undefined;
  // A phase's registry half is the only thing that may create a row, because it
  // is the only one that names a status. A null-phase write carries fields
  // alone, so for an origin with no row there is no status it could honestly be
  // given and the write stays on the live half.
  const registryPhase: (RegistryPatch & { status: FederationRegistryStatus }) | null =
    spec && spec.registry ? { ...write.registry, ...spec.registry() } : null;
  const registryFields: RegistryPatch | null = spec ? null : (write.registry ?? null);

  let written: ConnectedInstance | undefined;

  useInstanceStore.setState((state) => {
    let instances: ConnectedInstance[];
    if (spec && write.insert) {
      // A new live entry, which only a phase can give a status to.
      instances = [
        ...state.instances.filter((i) => i.origin !== origin),
        { ...write.insert, ...write.live, status: spec.live, error },
      ];
    } else {
      instances = state.instances.map((i) => {
        if (i.origin !== origin) return i;
        return spec ? { ...i, ...write.live, status: spec.live, error } : { ...i, ...write.live };
      });
    }

    written = instances.find((i) => i.origin === origin);

    const patch: Partial<InstanceState> = { instances };
    if (write.isLoading !== undefined) patch.isLoading = write.isLoading;

    if (registryPhase) {
      patch.registry = upsertRegistryEntry(state.registry, origin, { ...registryPhase, origin });
      patch.registryUpdatedAt = Date.now();
    } else if (registryFields) {
      const entry = state.registry.get(origin);
      if (entry) {
        patch.registry = new Map(state.registry).set(origin, { ...entry, ...registryFields });
        patch.registryUpdatedAt = Date.now();
      }
    }
    return patch;
  });

  return written;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface InstanceState {
  instances: ConnectedInstance[];
  isLoading: boolean;
  error: string | null;
  _autoConnectDone: boolean;
  registry: Map<string, FederationRegistryEntry>;
  registryUpdatedAt: number;
  // True once we've successfully fetched the authoritative registry from the
  // home server at least once this session. Until then, syncRegistry() must
  // not PUT — our local view is incomplete and would clobber server state.
  _registrySyncReady: boolean;
  syncRegistry: () => Promise<void>;
  deleteIdentity: (origins: string[], mode?: 'leave' | 'soft' | 'full') => Promise<Record<string, { success: boolean; error?: string; ownedSpaces?: { id: string; name: string }[] }>>;
  forceRemoveEntry: (origin: string) => void;

  probeInstance: (url: string) => Promise<InstanceInfoResponse & { origin: string }>;
  connectToRemote: (origin: string, password: string, displayName?: string) => Promise<void>;
  loginToRemote: (origin: string, username: string, password: string) => Promise<void>;
  disconnectInstance: (origin: string) => void;
  setInstanceStatus: (origin: string, status: ConnectedInstance['status'], error?: string) => void;
  reconnectInstance: (origin: string) => Promise<void>;
  reauthenticateInstance: (origin: string, password: string) => Promise<void>;
  updateInstanceToken: (origin: string, newToken: string) => void;
  syncInstanceList: () => Promise<void>;
  autoConnectAll: () => Promise<void>;
  reset: () => void;
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  isLoading: false,
  error: null,
  _autoConnectDone: false,
  registry: new Map(),
  registryUpdatedAt: 0,
  _registrySyncReady: false,

  probeInstance: async (url: string) => {
    const origin = normalizeOrigin(url);

    // Reject self-connection
    if (isSelfOrigin(url)) {
      throw new Error("You're already logged into this instance");
    }

    // Reject duplicates — but only if already connected/connecting.
    // Allow re-adding instances that are in error/disconnected state.
    const existing = get().instances.find(i => i.origin === origin);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
      throw new Error('This instance is already connected');
    }

    // Probe with unauthenticated client
    const tempClient = createApiClient(origin, () => null);
    const info = await tempClient.instance.info();

    return { ...info, origin };
  },

  connectToRemote: async (origin: string, password: string, displayName?: string) => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) throw new Error('Not logged in');

    set({ isLoading: true, error: null });

    try {
      // Compute the user's true home identity. If we're a federated user
      // (e.g. erin@nova browsing orbit), homeInstance points at the real home,
      // not window.location.host.
      const trueHomeHost = currentUser.homeInstance ?? window.location.host;
      const bareUsername = currentUser.username.includes('@')
        ? currentUser.username.split('@')[0]!
        : currentUser.username;
      const trueHomeUserId = currentUser.homeUserId ?? currentUser.id;
      const targetHost = new URL(origin).host;
      const targetIsHome = targetHost === trueHomeHost;

      const tempClient = createApiClient(origin, () => null);

      let response: AuthResponse | null = null;
      let finalUsername: string;
      let credentialOrigin: string | null = null;
      let homeApi: BackspaceApiClient | null = null;

      if (targetIsHome) {
        // Target IS the user's home instance — they already have a native
        // account there, and the entered password is that account's password.
        // The login itself is the verification, so there is nothing to pre-check.
        finalUsername = bareUsername;
        try {
          response = await tempClient.auth.login({
            username: bareUsername,
            password,
          });
        } catch {
          throw new DifferentPasswordError(bareUsername);
        }
      } else {
        // Target is a remote/third-party instance. The entered password is
        // checked by the account's OWN home instance and never travels to the
        // target; the target is given a per-remote secret the home issues.
        homeApi = resolveCredentialHomeApi();
        if (!homeApi) {
          throw new Error(
            `Connect to your home instance (${trueHomeHost}) first — it issues the credential for ${targetHost}`,
          );
        }

        const { valid } = await homeApi.users.verifyPassword(password);
        if (!valid) {
          throw new Error('Incorrect password');
        }

        const credential = await homeApi.users.federationCredential({ origin });
        credentialOrigin = credential.origin;
        finalUsername = `${bareUsername}@${trueHomeHost}`;

        // 2a: Attempt registration with namespaced username
        try {
          response = await tempClient.auth.register({
            username: finalUsername,
            password: credential.secret,
            displayName: displayName || currentUser.displayName || undefined,
            homeInstance: trueHomeHost,
            homeUserId: trueHomeUserId,
          });
        } catch (err) {
          // Already registered, or registration closed: fall through to login.
          // The status fallback covers a remote instance on a version that
          // sends no code yet.
          const registeredOrClosed = err instanceof HttpError && (
            err.code === 'username_taken' ||
            err.code === 'registration_closed' ||
            err.code === 'federated_registration_closed' ||
            err.status === 409 ||
            err.status === 403
          );
          if (!registeredOrClosed) {
            throw err;
          }
        }

        // 2b: If registration didn't work, try login with the issued secret.
        // There is deliberately no retry with the entered password: an account
        // that does not accept the issued secret is reached through the explicit
        // per-instance login form, where the user chooses what to send.
        if (!response) {
          try {
            response = await tempClient.auth.login({
              username: finalUsername,
              password: credential.secret,
            });
          } catch {
            throw new DifferentPasswordError(finalUsername);
          }
        }
      }

      if (!response) {
        throw new Error('Failed to authenticate with remote instance');
      }

      // The remote account now authenticates with the issued secret — record it
      // so no later launch tries to migrate an already-migrated account.
      if (homeApi && credentialOrigin) {
        await homeApi.users
          .federationCredential({ origin: credentialOrigin, markProvisioned: true })
          .catch((err) => console.warn('[federation] Could not record credential state:', err));
      }

      // Step 3: Complete connection
      const info = await tempClient.instance.info();
      const authenticatedClient = createApiClient(origin, () => response.token);

      // Replace by origin, never append: a re-authentication runs this over
      // the placeholder in `error` or `disconnected`, which stays in the list
      // until the new session takes its place, so the origin is never absent
      // (Outer Space dedupes against this list at render).
      const instance = writeConnectionState(origin, 'connected', {
        insert: {
          origin,
          label: info.name,
          token: response.token,
          user: response.user,
          username: finalUsername,
          api: authenticatedClient,
        },
        registry: {
          label: info.name,
          username: finalUsername,
          remoteUserId: response.user.id,
          addedAt: get().registry.get(origin)?.addedAt ?? Date.now(),
        },
        isLoading: false,
      });
      saveCachedTokens(get().instances, currentUser.id);

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Automatic re-attach for detached accounts (re-attach spec §3.4).
      maybeAutoReattach(instance).catch(() => {});

      // Ensure server-to-server peering for DM relay (non-fatal)
      try {
        const peerResult = await api.federation.ensurePeered({ remoteOrigin: origin });
        if (peerResult.peeringStatus === 'rejected') {
          const { addToast } = useUIStore.getState();
          addToast(
            `Cross-instance messaging unavailable — ${instance.label} requires manual peering approval`,
            'warning',
            10000,
          );
        } else if (peerResult.peeringStatus === 'pending') {
          const { addToast } = useUIStore.getState();
          addToast(
            `Peering with ${instance.label} in progress — cross-instance messaging will be available shortly`,
            'info',
          );
        }
      } catch (err) {
        console.warn('[federation] Peering attempt failed (non-fatal):', err);
      }

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
      get().syncRegistry().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message });
      throw err;
    }
  },

  loginToRemote: async (origin: string, username: string, password: string) => {
    set({ isLoading: true, error: null });

    try {
      const tempClient = createApiClient(origin, () => null);
      const response = await tempClient.auth.login({ username, password });

      // Fetch instance info for the label
      const info = await tempClient.instance.info();

      const authenticatedClient = createApiClient(origin, () => response.token);

      // Replace by origin, as connectToRemote does: the explicit login is the
      // fallback for an origin whose placeholder may still be in the list.
      const instance = writeConnectionState(origin, 'connected', {
        insert: {
          origin,
          label: info.name,
          token: response.token,
          user: response.user,
          username: response.user.username,
          api: authenticatedClient,
        },
        registry: {
          label: info.name,
          username: response.user.username,
          remoteUserId: response.user.id,
          addedAt: get().registry.get(origin)?.addedAt ?? Date.now(),
        },
        isLoading: false,
      });
      const userId = useAuthStore.getState().user?.id;
      if (userId) saveCachedTokens(get().instances, userId);

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Automatic re-attach for detached accounts (re-attach spec §3.4).
      maybeAutoReattach(instance).catch(() => {});

      // The user just authenticated with a password of their own choosing, so
      // the remote hash is whatever they typed. Force it back onto the
      // home-issued secret (no-op unless this is our own federated identity).
      ensureRemoteCredential(instance, { force: true }).catch((err) =>
        console.warn('[federation] Could not reconcile remote credential:', err),
      );

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
      get().syncRegistry().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message });
      throw err;
    }
  },

  setInstanceStatus: (origin, status, error) => {
    const prev = get().instances.find(i => i.origin === origin)?.status;
    // The socket layer's mirror of its own liveness, which is not a registry
    // event: see the `live-*` phases.
    writeConnectionState(origin, `live-${status}`, { error });
    if (prev === 'connected' && (status === 'disconnected' || status === 'error')) {
      failoverDmOriginsFromDisconnected(origin);
    }
  },

  disconnectInstance: (origin: string) => {
    // Tear down WebSocket connection (stops auto-reconnect)
    disconnectWs(origin);

    // Keep the instance in the array with status 'disconnected' — preserves
    // the token and API client so reconnect is instant (no re-auth needed).
    writeConnectionState(origin, 'disconnected');
    const userId = useAuthStore.getState().user?.id;
    if (userId) saveCachedTokens(get().instances, userId);

    // Failover DMs to a connected sibling BEFORE removeInstanceSpaces wipes
    // this origin's pins. DMs with a connected alternative survive via rekey;
    // DMs without one are removed alongside the rest of the instance's content.
    failoverDmOriginsFromDisconnected(origin);
    useSpaceStore.getState().removeInstanceSpaces(origin);

    // Sync updated lists to remaining instances (fire-and-forget)
    get().syncInstanceList().catch(() => {});
    get().syncRegistry().catch(() => {});
  },

  reconnectInstance: async (origin: string) => {
    let inst = get().instances.find(i => i.origin === origin);

    // A live session, or an attempt already in flight, needs no second one.
    // Asked of the entry the store already held, never of the placeholder the
    // restore below inserts: that placeholder stands for this very attempt and
    // is therefore `connecting`, so asking after it returned here with the
    // cached token unverified and no socket opened, and left the origin in
    // `connecting` for the next caller to read as a session.
    if (inst && (inst.status === 'connected' || inst.status === 'connecting')) return;

    // If the instance was disconnected (removed from active instances array) but
    // has a cached token in localStorage, restore it so reconnect can proceed.
    if (!inst) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      const cached = loadCachedTokens(userId);
      const entry = cached[origin];
      if (!entry?.token) return; // No cached token — needs full re-authentication via connectToRemote

      const currentUser = useAuthStore.getState().user;
      if (!currentUser) return;

      const client = createApiClient(origin, () => entry.token);
      inst = writeConnectionState(origin, 'live-connecting', {
        insert: {
          origin,
          label: entry.label || new URL(origin).host,
          token: entry.token,
          user: currentUser,
          username: entry.username || '',
          api: client,
        },
      });
    }

    // Tokenless placeholders can't reconnect — they need full re-authentication
    if (!inst.token) return;

    // Set to connecting
    writeConnectionState(origin, 'live-connecting');

    try {
      const user = await inst.api.users.me();

      // Refresh the instance label (non-critical — a failure here must not
      // block a successful token reconnect).
      let info: (InstanceInfoResponse) | null = null;
      try {
        info = await inst.api.instance.info();
      } catch {
        // Keep whatever label the instance already had.
      }

      writeConnectionState(origin, 'connected', {
        live: { user, ...(info ? { label: info.name } : {}) },
      });
      get().syncRegistry().catch(() => {});

      connectInstance(origin, inst.token);

      // Same reconciliation as autoConnectAll: a still-valid token is the one
      // chance to migrate a connection made before per-remote secrets existed
      // without asking for a password. No-op once marked provisioned.
      const reconnected = get().instances.find(i => i.origin === origin);
      if (reconnected) {
        ensureRemoteCredential(reconnected).catch((err2) =>
          console.warn(`[federation] Credential migration deferred for ${origin}:`, err2),
        );
      }
    } catch (err) {
      if (isNetworkError(err)) {
        writeConnectionState(origin, 'unreachable');
        // The socket's own backoff is what recovers this one.
        connectInstance(origin, inst.token);
      } else {
        writeConnectionState(origin, 'token-expired');
      }
    }
  },

  reauthenticateInstance: async (origin: string, password: string) => {
    // The stale placeholder (error or disconnected) stays in `instances`
    // until connectToRemote replaces it by origin on success. Removing it up
    // front left the origin absent for the request's duration, and for good
    // on a wrong password, so its spaces surfaced in Outer Space under a chip
    // saying the session had expired. Its spaces and socket do go now: the
    // new session's ready payload brings them back.
    if (get().instances.some((i) => i.origin === origin)) {
      useSpaceStore.getState().removeInstanceSpaces(origin);
    }
    disconnectWs(origin);

    // Re-connect through the standard flow (handles register/login)
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    await get().connectToRemote(
      origin,
      password,
      currentUser.displayName || undefined,
    );
  },

  updateInstanceToken: (origin: string, newToken: string) => {
    set((state) => ({
      instances: state.instances.map(i => {
        if (i.origin !== origin) return i;
        // Recreate API client with new token
        const newApi = createApiClient(origin, () => newToken);
        return { ...i, token: newToken, api: newApi };
      }),
    }));

    const userId = useAuthStore.getState().user?.id;
    if (userId) saveCachedTokens(get().instances, userId);

    // Reconnect WebSocket with new token
    disconnectWs(origin);
    connectInstance(origin, newToken);
  },

  syncInstanceList: async () => {
    // Prevent premature sync before autoConnectAll has populated all server-known
    // instances — otherwise a user action (add/remove) would overwrite the server
    // record with only the currently-loaded subset, permanently erasing the rest
    if (!get()._autoConnectDone) return;

    const { instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    // Build perspective-correct replicated instance lists.
    // Each instance should store references to OTHER instances, never itself.
    const homeOrigin = window.location.origin;
    const homeUsername = currentUser.username.includes('@')
      ? currentUser.username.split('@')[0]!
      : currentUser.username;

    // Home list: all remotes (home never references itself)
    const homeList: ReplicatedInstance[] = instances.map(inst => ({
      origin: inst.origin,
      username: inst.username,
    }));

    // Push to home instance
    const homePromise = api.users.update({ replicatedInstances: homeList }).catch((err) => {
      console.warn('Failed to sync instance list to home:', err);
    });

    // Push perspective-correct list to each remote instance:
    // include home + all OTHER remotes, but exclude the remote's own origin
    const connectedInstances = instances.filter(inst => inst.status === 'connected');
    const remotePromises = connectedInstances.map(inst => {
      const listForRemote: ReplicatedInstance[] = [
        { origin: homeOrigin, username: homeUsername },
        ...instances
          .filter(other => other.origin !== inst.origin)
          .map(other => ({ origin: other.origin, username: other.username })),
      ];
      return inst.api.users.update({ replicatedInstances: listForRemote }).catch((err) => {
        console.warn(`Failed to sync instance list to ${inst.origin}:`, err);
      });
    });

    await Promise.all([homePromise, ...remotePromises]);
  },

  syncRegistry: async () => {
    if (!get()._autoConnectDone) return;
    // Block PUT until we've successfully read the authoritative server registry
    // at least once. Otherwise a transient GET failure during autoConnectAll
    // would let us push an empty/incomplete registry with a fresh timestamp,
    // wiping legitimate server-side entries via LWW.
    if (!get()._registrySyncReady) return;

    const { registry, registryUpdatedAt, instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    const entries = Array.from(registry.values());
    const payload = { registry: entries, updatedAt: registryUpdatedAt };

    // Push to home instance
    const homePromise = api.users.putFederationRegistry(payload).catch((err) => {
      console.warn('Failed to sync registry to home:', err);
    });

    // Push to all connected remote instances
    const connectedInstances = instances.filter(i => i.status === 'connected');
    const remotePromises = connectedInstances.map(inst =>
      inst.api.users.putFederationRegistry(payload).catch((err) => {
        console.warn(`Failed to sync registry to ${inst.origin}:`, err);
      })
    );

    await Promise.all([homePromise, ...remotePromises]);
  },

  deleteIdentity: async (origins: string[], mode: 'leave' | 'soft' | 'full' = 'leave') => {
    try {
      const { results } = await api.users.deleteFederationIdentity({ origins, mode });

      // Clean up client-side state for successful deletions
      for (const [origin, result] of Object.entries(results)) {
        if (result.success) {
          get().forceRemoveEntry(origin);
        }
      }

      return results;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return Object.fromEntries(origins.map(o => [o, { success: false as const, error }]));
    }
  },

  forceRemoveEntry: (origin: string) => {
    // Tear down WebSocket if connected
    disconnectWs(origin);

    // A removal is not a phase: there is no status left to agree on, and both
    // halves go in the one `set` below.
    const registry = new Map(get().registry);
    registry.delete(origin);
    const registryUpdatedAt = Date.now();

    // Remove from instances and purge token from localStorage
    set((state) => {
      const updated = state.instances.filter(i => i.origin !== origin);
      const userId = useAuthStore.getState().user?.id;
      if (userId) saveCachedTokens(updated, userId);
      return { instances: updated, registry, registryUpdatedAt };
    });

    // Same rationale as disconnectInstance — preserve DMs with connected alts.
    failoverDmOriginsFromDisconnected(origin);
    useSpaceStore.getState().removeInstanceSpaces(origin);

    get().syncRegistry().catch(() => {});
  },

  autoConnectAll: async () => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) {
      set({ _autoConnectDone: true });
      return;
    }

    const cached = loadCachedTokens(currentUser.id);

    // Fetch server-side registry (source of truth for entry list)
    let serverRegistry: FederationRegistryEntry[] = [];
    let serverRegistryUpdatedAt = 0;
    let serverRegistryFetched = false;
    try {
      const res = await api.users.getFederationRegistry();
      serverRegistry = res.registry;
      serverRegistryUpdatedAt = res.updatedAt;
      serverRegistryFetched = true;
    } catch (err) {
      console.warn('Failed to fetch federation registry from home:', err);
    }

    // Initialize registry from server data
    const registry = new Map<string, FederationRegistryEntry>();
    for (const entry of serverRegistry) {
      registry.set(entry.origin, entry);
    }

    // Seed any replicatedInstances that aren't yet in the registry. This covers
    // (a) accounts whose remotes were added before the federation registry table
    // existed, and (b) the GET-failed degraded mode where we still want the user
    // to see their known connections (as auth_expired) instead of an empty list.
    // These synthesized entries are display-only until the next successful GET
    // — we never PUT while _registrySyncReady is false.
    for (const ri of currentUser.replicatedInstances) {
      const origin = ri.origin || `https://${ri.domain}`;
      if (isSelfOrigin(origin)) continue;
      if (registry.has(origin)) continue;
      registry.set(origin, {
        origin,
        label: new URL(origin).host,
        username: ri.username || '',
        remoteUserId: '',
        status: 'auth_expired',
        addedAt: Date.now(),
        lastConnectedAt: null,
        disconnectedAt: null,
        errorMessage: registryReason('reauthenticate'),
      });
    }

    // Migration: promote localStorage-only entries to registry. The seed says
    // `auth_expired`, the same status a known connection with no proven session
    // gets above, because a cached token is not a session: an origin that is
    // absent from `replicatedInstances` is never in the connect phase below, so
    // it gets no live entry at all and a row saying `connected` would stand for
    // a session that nothing is holding. An origin the connect phase does reach
    // (the home instance of a federated account) moves off this status in the
    // same run, and only `disconnected` would have kept it from being tried.
    for (const [origin] of Object.entries(cached)) {
      if (origin === window.location.origin) continue;
      if (!registry.has(origin)) {
        registry.set(origin, {
          origin,
          label: cached[origin]?.label || new URL(origin).host,
          username: cached[origin]?.username || '',
          remoteUserId: '',
          status: 'auth_expired',
          addedAt: Date.now(),
          lastConnectedAt: null,
          disconnectedAt: null,
          errorMessage: registryReason('reauthenticate'),
        });
      }
    }

    // If logged in as a federated user, include the home instance as a
    // connection target. It won't be in replicatedInstances (you don't
    // "federate to" your own home), but the client needs it for friends,
    // DMs, and profile data.
    const instancesToConnect = [...currentUser.replicatedInstances];
    if (currentUser.homeInstance) {
      const homeOrigin = `https://${currentUser.homeInstance}`;
      if (!isSelfOrigin(homeOrigin)) {
        // Compute bare username (strip @domain suffix if present)
        const bareUsername = currentUser.username.includes('@')
          ? currentUser.username.split('@')[0]!
          : currentUser.username;

        const alreadyIncluded = instancesToConnect.some(ri =>
          (ri.origin || `https://${ri.domain}`) === homeOrigin
        );
        if (!alreadyIncluded) {
          instancesToConnect.push({
            origin: homeOrigin,
            username: bareUsername,
            domain: currentUser.homeInstance,
          });
        }

        // Ensure the home instance has a registry entry so it appears
        // in the Connections UI (the registry is the source of truth for
        // the Connections panel, not the instances array).
        if (!registry.has(homeOrigin)) {
          registry.set(homeOrigin, {
            origin: homeOrigin,
            label: currentUser.homeInstance,
            username: bareUsername,
            remoteUserId: currentUser.homeUserId ?? '',
            status: 'auth_expired',
            addedAt: Date.now(),
            lastConnectedAt: null,
            disconnectedAt: null,
            errorMessage: registryReason('authenticate_home'),
          });
        }
      }
    }

    // Early return if there's nothing to connect
    if (instancesToConnect.length === 0 && registry.size === 0) {
      set({ _autoConnectDone: true });
      return;
    }

    // Publish the reconciled registry before the connect phase starts. What the
    // seeding above built is the last state the server and localStorage knew;
    // everything from here is a live connection changing state, so it goes
    // through `writeConnectionState` and lands on the store's Map rather than on
    // a local copy this function would have to remember to publish. Nothing is
    // pushed yet: `syncRegistry` is a no-op until `_autoConnectDone`.
    set({ registry });

    // Split server-known instances into three groups:
    // - withToken: have a cached token and should auto-connect
    // - withoutToken: no cached token → add as error placeholder
    // - userDisconnected: user explicitly disconnected → add as disconnected placeholder (no auto-connect)
    const withToken: Array<{ origin: string; ri: (typeof instancesToConnect)[0]; entry: CachedInstanceToken }> = [];
    const withoutToken: Array<{ origin: string; ri: (typeof instancesToConnect)[0] }> = [];
    const userDisconnected: Array<{ origin: string; ri: (typeof instancesToConnect)[0]; entry: CachedInstanceToken }> = [];

    for (const ri of instancesToConnect) {
      const origin = ri.origin || `https://${ri.domain}`;
      // Never connect to ourselves — home WS is managed separately
      if (isSelfOrigin(origin)) continue;
      if (get().instances.some(i => i.origin === origin)) continue; // already loaded
      const cachedEntry = cached[origin];
      const regEntry = get().registry.get(origin);
      if (cachedEntry) {
        // Respect user's explicit disconnect — don't auto-reconnect
        if (regEntry?.status === 'disconnected') {
          userDisconnected.push({ origin, ri, entry: cachedEntry });
        } else {
          withToken.push({ origin, ri, entry: cachedEntry });
        }
      } else {
        withoutToken.push({ origin, ri });
      }
    }

    // Add user-disconnected instances as disconnected placeholders (token preserved
    // so reconnect is instant, but no WebSocket or API calls until user clicks reconnect).
    // The registry already says `disconnected` — that is how they were sorted into
    // this group — so the placeholder is a live-only write and the row keeps the
    // time the user actually disconnected.
    for (const { origin, entry: cachedEntry } of userDisconnected) {
      writeConnectionState(origin, 'live-disconnected', {
        insert: {
          origin,
          label: cachedEntry.label || new URL(origin).host,
          token: cachedEntry.token,
          user: currentUser,
          username: cachedEntry.username || '',
          api: createApiClient(origin, () => cachedEntry.token),
        },
      });
    }

    // Immediately add tokenless placeholders so they're visible in Zustand
    // (and therefore won't be erased by syncInstanceList)
    for (const { origin, ri } of withoutToken) {
      writeConnectionState(origin, 'no-session', {
        insert: {
          origin,
          label: new URL(origin).host,
          token: '',
          user: currentUser, // placeholder
          username: ri.username,
          api: createApiClient(origin, () => null),
        },
      });
    }

    // Connect instances with cached tokens in parallel
    if (withToken.length > 0) {
      const results = await Promise.allSettled(
        withToken.map(async ({ origin, ri, entry: cachedEntry }) => {
          // Create client with cached token
          const client = createApiClient(origin, () => cachedEntry.token);

          // Set as connecting
          writeConnectionState(origin, 'live-connecting', {
            insert: {
              origin,
              label: cachedEntry.label || new URL(origin).host,
              token: cachedEntry.token,
              user: currentUser, // Placeholder until we verify
              username: cachedEntry.username || ri.username,
              api: client,
            },
          });

          try {
            // Verify the token is still valid
            const user = await client.users.me();

            // Fetch instance info for a fresh label
            let label = cachedEntry.label || new URL(origin).host;
            let info: InstanceInfoResponse | null = null;
            try {
              info = await client.instance.info();
              label = info.name;
            } catch {
              // Non-critical — keep cached label
            }

            // Backfill homeUserId if missing (existing federated users before this field existed)
            if (user.homeInstance && !user.homeUserId) {
              const homeUser = useAuthStore.getState().user;
              if (homeUser) {
                client.users.update({ homeUserId: homeUser.id }).catch(() => {});
              }
            }

            // Backfill cached username if stale after server-side migration
            // (e.g. "test" was renamed to "test@nova.ddns.net")
            if (user.username !== cachedEntry.username) {
              cachedEntry.username = user.username;
            }

            const connectedInstance = writeConnectionState(origin, 'connected', {
              live: { label, user, username: user.username },
              registry: { label, remoteUserId: user.id },
            });

            // Open WebSocket connection now that we've verified the token
            connectInstance(origin, cachedEntry.token);

            // Migrate connections provisioned before per-remote secrets existed,
            // while this still-valid token makes it possible without a password.
            // No-op once the home instance has the account marked provisioned.
            if (connectedInstance) {
              ensureRemoteCredential(connectedInstance).catch((err) =>
                console.warn(`[federation] Credential migration deferred for ${origin}:`, err),
              );
            }

            // Initiate server-to-server peering for DM relay (non-fatal, idempotent)
            api.federation.ensurePeered({ remoteOrigin: origin }).catch(() => {});
          } catch (err) {
            if (isNetworkError(err)) {
              // Instance unreachable (NAT hairpinning, DNS, server down) — token may still be valid
              writeConnectionState(origin, 'unreachable');

              // Start WebSocket — its built-in exponential backoff retry will auto-recover
              // when the network path becomes available (e.g. user switches networks)
              connectInstance(origin, cachedEntry.token);
            } else {
              // Auth failure (401, invalid token, etc.)
              writeConnectionState(origin, 'token-expired');
            }
          }
        })
      );

      // Log any failures for debugging
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(`autoConnectAll: ${failures.length}/${withToken.length} instances failed to connect`);
      }
    }

    // Save final state to localStorage — persist ALL instances regardless of status
    // so tokens are preserved for instant reconnect (registry controls auto-connect behavior)
    saveCachedTokens(get().instances, currentUser.id);

    // Stamp the reconciled registry the connect phase left on the store. The
    // stamp is the LWW clock the home server compares against, not a record
    // that a status moved, which is why it is written here and not by
    // `writeConnectionState`. _registrySyncReady gates outbound PUTs: only flip
    // true when we've authoritatively read from the home server.
    const registryUpdatedAt = serverRegistryUpdatedAt > 0 ? Math.max(serverRegistryUpdatedAt, Date.now()) : Date.now();
    set({
      _autoConnectDone: true,
      registryUpdatedAt,
      _registrySyncReady: serverRegistryFetched,
    });

    // Sync reconciled registry to all instances (no-ops if fetch failed)
    if (serverRegistryFetched) {
      get().syncRegistry().catch(() => {});
    }
  },

  reset: () => {
    // Clean up space store for each connected remote instance before tearing down
    const { instances } = get();
    for (const inst of instances) {
      useSpaceStore.getState().removeInstanceSpaces(inst.origin);
    }

    // Tear down all remote WebSocket connections
    disconnectAllRemote();


    set({ instances: [], isLoading: false, error: null, _autoConnectDone: false, registry: new Map(), registryUpdatedAt: 0, _registrySyncReady: false });
    // Token cache preserved — scoped per user, survives logout for seamless reconnect
  },
}));

// ─── Shared connect path ─────────────────────────────────────────────────────

export type ConnectOutcome =
  | { kind: 'connected'; how: 'new' | 'reconnect' | 'already' | 'resumed' }
  /** No password was typed and no cached session could be resumed: ask for one. */
  | { kind: 'needs-password' }
  | { kind: 'needs-remote-password'; remoteUsername: string };

/**
 * The origin, as the store spells it, that a cached token could still carry
 * back: a live instance the user disconnected or whose session errored, as
 * long as it kept its token, or (with no live instance) a registry entry the
 * user disconnected, whose token `reconnectInstance` restores from
 * `localStorage`. Null when there is nothing to resume.
 *
 * The registry side lists `disconnected` only. `unreachable` has a chip that
 * retries it already, and `auth_expired` is what a refused token becomes, so
 * neither is worth a second attempt from a card. The live side does include
 * `error`, that status's live counterpart, because a live instance can hold
 * a token the registry has not judged yet; such an origin is inner anyway,
 * so no card opens the dialog for it.
 */
export function resumableOrigin(state: InstanceState, canonical: string): string | null {
  const live = state.instances.find((i) => normalizeOrigin(i.origin) === canonical);
  if (live) {
    const stale = live.status === 'disconnected' || live.status === 'error';
    return stale && live.token !== '' ? live.origin : null;
  }
  for (const entry of state.registry.values()) {
    if (normalizeOrigin(entry.origin) === canonical && entry.status === 'disconnected') return entry.origin;
  }
  return null;
}

/** The registry status for an origin after a reconnect attempt, however the store spells it. */
function registryStatusFor(state: InstanceState, canonical: string): FederationRegistryEntry['status'] | undefined {
  for (const entry of state.registry.values()) {
    if (normalizeOrigin(entry.origin) === canonical) return entry.status;
  }
  return undefined;
}

/**
 * The one way to establish a session on another instance from a user-typed
 * password: the Connections panel and the directory's connect-then-join flow
 * both go through it. The branch is by the status the store holds for the
 * origin: `error` or `disconnected` is re-authenticated in place;
 * `connected` or `connecting` is usable already and short-circuits without
 * touching the store (`connectToRemote` has no duplicate check of its own
 * and would append a second entry); an unknown origin connects. A remote
 * account that does not accept the home-issued credential is reported as
 * `needs-remote-password` so the caller can offer the explicit per-instance
 * login form; every other failure is thrown as is.
 *
 * Called with an empty password it asks nothing of the user yet: an origin
 * a cached token could carry back is resumed through `reconnectInstance`
 * (the same token reconnect the Connections row and the Explore chips use),
 * and the caller learns `resumed`, or `needs-password` when there was no
 * session to resume or the token was refused. An instance that turned out
 * unreachable is reported as `peer_unreachable` rather than as a password
 * the user could fix. This is what lets a card for an instance the user
 * disconnected join without a prompt they gain nothing from.
 *
 * This does not validate a typed URL: a caller that wants the self and
 * duplicate checks for user input still runs `probeInstance` first, as the
 * Connections flow does.
 */
export async function connectToInstance(
  origin: string,
  password: string,
  displayName?: string,
): Promise<ConnectOutcome> {
  const store = useInstanceStore.getState();
  const canonical = normalizeOrigin(origin);
  const existing = store.instances.find((i) => normalizeOrigin(i.origin) === canonical);
  if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
    return { kind: 'connected', how: 'already' };
  }

  if (password === '') {
    const resumable = resumableOrigin(store, canonical);
    if (!resumable) return { kind: 'needs-password' };
    await store.reconnectInstance(resumable);
    const after = useInstanceStore.getState();
    const live = after.instances.find((i) => normalizeOrigin(i.origin) === canonical);
    if (live?.status === 'connected') return { kind: 'connected', how: 'resumed' };
    if (registryStatusFor(after, canonical) === 'unreachable') {
      throw new HttpError(503, 'peer_unreachable', { error: 'peer_unreachable', code: 'peer_unreachable', statusCode: 503 }, 'peer_unreachable');
    }
    return { kind: 'needs-password' };
  }

  try {
    if (existing) {
      await store.reauthenticateInstance(existing.origin, password);
      return { kind: 'connected', how: 'reconnect' };
    }
    await store.connectToRemote(canonical, password, displayName);
    return { kind: 'connected', how: 'new' };
  } catch (err) {
    if (err instanceof DifferentPasswordError) {
      return { kind: 'needs-remote-password', remoteUsername: err.remoteUsername };
    }
    throw err;
  }
}

// ─── API client resolution ───────────────────────────────────────────────────
// Register the resolver with spaceStore so getApiForOrigin() works everywhere.
// Placed after store creation so useInstanceStore is definitely initialized.
// This breaks the circular dependency: chatStore → spaceStore ← instanceStore
// instead of: chatStore → instanceStore → useWebSocket → chatStore (cycle).

setApiForOriginResolver((origin: string): BackspaceApiClient => {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  if (!instance) return api;
  return instance.api;
});

// ─── User ID resolution (federation) ──────────────────────────────────────────
// Maps an origin to the local user's ID on that remote instance.
// Used by voice join/leave to optimistically add/remove the correct user ID.

setUserIdForOriginResolver((origin: string): string | undefined => {
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.user.id;
});

// ─── Token resolution (federation) ────────────────────────────────────────────
// Maps an origin to the JWT for that instance. Used by transferStore for tus
// uploads and any other path that constructs raw HTTP requests to a federated
// instance and needs to pass an Authorization header.
//
// Empty origin reads from localStorage, mirroring the home `api` client
// (api/client.ts). authStore.token is the React-state mirror of the same value
// and is written together with localStorage by initSession/logout — but the
// register page intentionally writes localStorage *before* initSession (so
// AuthRedirect doesn't yank the user off /register while the avatar is still
// uploading). Reading authStore.token here would return null in that window
// and the upload would silently fail. Aligning with the api client closes the
// gap and gives one source of truth for the home JWT.

setTokenForOriginResolver((origin: string): string | null => {
  if (!origin) return localStorage.getItem('backspace_token');
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.token ?? null;
});

// ─── Electron: push connected-instance origins to main process ───────────────
// Enables the main process to intercept invite URLs that point to instances
// we're already signed into. Uses the basic subscribe(listener) form (no
// subscribeWithSelector middleware on this store) with a manual diff to avoid
// IPC spam on unrelated state changes (e.g. isLoading toggles, registry updates).
{
  let lastSerialized = '';
  const pushOrigins = (instances: ConnectedInstance[]) => {
    if (typeof window === 'undefined' || !window.backspace?.setConnectedOrigins) return;
    const origins = [
      window.location.origin,
      ...instances
        .filter(i => i.status === 'connected')
        .map(i => i.origin)
        .filter(Boolean),
    ];
    const serialized = origins.join('|');
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    window.backspace.setConnectedOrigins(origins);
  };

  // Initial push (current state at module load time)
  pushOrigins(useInstanceStore.getState().instances);

  // Push on every state change; guard above skips when origin set is unchanged
  useInstanceStore.subscribe((state) => {
    pushOrigins(state.instances);
  });
}

// ─── Hostname → origin resolution (federation) ────────────────────────────────
// Maps a user's homeInstance hostname to its full origin URL.

setOriginFromHostnameResolver((hostname: string): string => {
  const inst = useInstanceStore.getState().instances.find(i => {
    try { return new URL(i.origin).host === hostname; } catch { return false; }
  });
  return inst?.origin ?? '';
});
