import type { DirectoryPingError } from './types.js';

// ─── Instance Settings Types ────────────────────────────────────────────────

export interface InstanceAdminSettings {
  instanceName: string;
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
  discoveryEnabled: boolean;
  gifApiKey?: string;
  gifEnabled?: boolean;
  maxUploadSizeMb: number;
  federationRelayEnabled: boolean;
  federationRelayTtlDays: number;
  defaultAutoRotateIntervalDays: number;
  autoAcceptPeering: boolean;
  directoryEnabled: boolean;
  /**
   * The other directory axis: whether people on this instance see spaces from
   * other instances in Explore. Independent of `directoryEnabled`, which is
   * what this instance sends out. `DIRECTORY_ENDPOINT` sits above it: with no
   * endpoint there is nothing to browse whatever this says.
   */
  directoryBrowseEnabled: boolean;
  /** Read-only on the wire; the server ignores them on PATCH. */
  directoryLastPingAt: number | null;
  directoryLastError: DirectoryPingError | null;
  /**
   * Spaces here that have opted in to the directory and are not private,
   * counted whatever `directoryEnabled` says. Read-only, ignored on PATCH.
   * The instance switch lists nothing by itself; this is how the admin sees
   * whether any space has taken it up.
   */
  directoryListedSpaceCount: number;
  /**
   * The web client's Backspace page shows the Support card, which links to
   * the project's Ko-fi page. Hides only that card; the server does nothing
   * else with it. Default true. Also on `InstanceInfoResponse`.
   */
  supportCardEnabled: boolean;
}

export interface InstanceStreamingLimits {
  maxBitrateKbps: number;
  minBitrateKbps: number;
  bitrateStepKbps: number;
  allowedResolutions: (number | 'native')[];
  allowedFramerates: number[];
  maxResolution: number;
  maxFramerate: number;
  discoveryEnabled: boolean;
  /** The admin allows spaces here to be listed in the directory. Read-only on this route; PATCH /settings/instance sets it. */
  directoryEnabled: boolean;
  /**
   * This instance has a `DIRECTORY_ENDPOINT` to reach. Read-only and derived
   * from configuration, never stored, never accepted on a PATCH.
   *
   * It rides on this document because this is the one settings document any
   * signed-in user may read, on their own instance or on a peer: a space's
   * own instance answers for itself, which `GET /instance/info` on the home
   * instance cannot do for a space that lives somewhere else. Without it the
   * per-space listing switch was enabled on an instance with no endpoint,
   * writing a flag whose listing document no hub ever fetches.
   */
  directoryConfigured: boolean;
  bitrateMatrixOverrides: Record<string, number> | null;
  allowCustomBitrate: boolean;
}

// ─── Federation Types ──────────────────────────────────────────────────────

export interface InstanceInfoResponse {
  name: string;
  version: string;
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
  // Persistent per-instance epoch (incarnation UUID). Minted by ensureDefaults on
  // first boot and stable across restarts; changes only on a wipe/re-provision.
  // Peers use it to detect that a remote has been re-provisioned (self-healing).
  instanceId: string;
  // AGPL-3.0 § 13 network-use source offer: URL to the Corresponding Source of
  // the version this instance is running (operator-configurable via
  // BACKSPACE_SOURCE_URL so forks point at their own source).
  sourceCodeUrl: string;
  // Short git SHA/tag of the running build; null in dev builds with no commit injected.
  commit: string | null;
  // Three independent directory facts (directory.md section 9). They are
  // reported separately because folding any two of them into one boolean
  // leaves a client unable to tell which of them is false, and every surface
  // that says something about the directory needs a different one.
  //
  // directoryConfigured: the operator gave this instance a DIRECTORY_ENDPOINT.
  // Nothing about the directory works without it: no pinger, no proxy, no
  // Outer Space. Every surface that promises the directory will do something
  // gates on this.
  // directoryAvailable: people here browse the directory, which is
  // directoryConfigured and the admin's browse setting together. The Explore
  // page gates Outer Space on it.
  // directoryEnabled: the admin allows spaces here to be listed; the space
  // settings panel reads it.
  directoryConfigured: boolean;
  directoryAvailable: boolean;
  directoryEnabled: boolean;
  // The admin's switch for the Support card on the web client's Backspace
  // page. It only hides that card in the web client and changes nothing the
  // server does.
  supportCardEnabled: boolean;
}

/**
 * What the admin Updates panel renders. Admin-only.
 *
 * `state` is deliberately three-valued. An instance with no outbound internet,
 * or one whose operator turned the lookup off, must be able to say "I do not
 * know" instead of implying it is current.
 */
export interface InstanceUpdateStatus {
  current: {
    version: string;
    /** Short git SHA baked at build time; null in dev builds. */
    commit: string | null;
  };
  latest: {
    version: string;
    url: string;
    /** ISO 8601, or an empty string when the release carried no date. */
    publishedAt: string;
  } | null;
  state: 'up-to-date' | 'update-available' | 'unknown';
  /** Epoch ms of the lookup this answer came from; null when none was made. */
  checkedAt: number | null;
  /** False when BACKSPACE_UPDATE_CHECK=false. */
  checkEnabled: boolean;
  /** Why `state` is unknown, when it is. Null otherwise. */
  reason: 'disabled' | 'unreachable' | 'rate-limited' | 'unparseable' | null;
  /**
   * How this instance gets its image. `unknown` on installs that predate
   * install.sh recording it, which the panel handles by showing both sets of
   * manual commands rather than guessing.
   */
  channel: 'prebuilt' | 'source' | 'unknown';
}

export interface VerifyPasswordRequest {
  password: string;
}

export interface VerifyPasswordResponse {
  valid: boolean;
}

export interface ChangePasswordRequest {
  currentPassword?: string;  // Required on home, optional for federated users
  newPassword: string;
}

export interface ChangePasswordResponse {
  token: string;
}

export interface DeleteAccountRequest {
  password: string;
  username: string;  // Must match — confirmation safeguard
}

// ─── Per-Remote Federation Credentials ───────────────────────────────────
// The credential the client uses to register/log in as this user on ANOTHER
// instance. Issued and stored by the user's HOME instance only, so it stays
// identical across devices and browsing sessions. Never the home password.

export interface FederationCredentialRequest {
  origin: string;            // Remote instance origin, e.g. 'https://orbit.example'
  markProvisioned?: boolean; // Record that the remote account now uses this secret
}

export interface FederationCredentialResponse {
  origin: string;
  secret: string;
  provisioned: boolean;      // True once the remote account is known to use `secret`
}

// ─── Federation Identity Delete Types ────────────────────────────────────

export interface FederationIdentityDeleteRequest {
  origins: string[];
  mode: 'leave' | 'soft' | 'full';
}

export interface FederationIdentityDeleteResult {
  success: boolean;
  error?: string;
  ownedSpaces?: { id: string; name: string }[];
}

export interface FederationIdentityDeleteResponse {
  results: Record<string, FederationIdentityDeleteResult>;
}

export interface FederationIdentityDeleteS2SRequest {
  homeUserId: string;
  homeInstance: string;
  mode: 'soft' | 'full';
}

// ─── Storage Management Types ─────────────────────────────────────────────

export interface StorageBreakdown {
  type: string;   // 'image' | 'video' | 'audio' | 'document' | 'other'
  count: number;
  size: number;
}

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  referencedFiles: number;
  referencedSize: number;
  orphanedFiles: number;
  orphanedSize: number;
  unlinkedAttachments: number;
  unlinkedSize: number;
  danglingAttachments: number;
  danglingSize: number;
  /** Count of `.tus/` entries (payloads + sidecars) with mtime older than 1h. */
  staleTusSessions: number;
  /** Total size in bytes of those stale `.tus/` entries. */
  staleTusSize: number;
  breakdown: StorageBreakdown[];
}

export interface OrphanedFile {
  filename: string;
  size: number;
  modifiedAt: number;
}

export interface CleanupResult {
  dryRun: boolean;
  deletedFiles: number;
  freedBytes: number;
  deletedAttachmentRecords: number;
  errors: string[];
}

// ─── Admin User Management Types ──────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  avatarColor: string | null;
  status: string;
  isAdmin: boolean;
  isDeleted: boolean;
  homeInstance: string | null;
  createdAt: number;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminResetPasswordResponse {
  temporaryPassword: string;
}
