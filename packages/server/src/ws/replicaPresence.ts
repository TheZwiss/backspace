import { eq } from 'drizzle-orm';
import { ownsChosenStatus, type ChosenUserStatus, type UserStatus } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { replicaLiveStatus, statusOnConnect, type StatusSourceRow } from '../utils/presenceStatus.js';

/**
 * The one writer of a replicated row's live `users.status` (a row that does not
 * own its status, `ownsChosenStatus`). The rule is in activity-presence.md,
 * "Replica presence"; every path that moves such a row's status calls one of
 * the functions below and nothing else writes it.
 *
 * The home's projection is kept in memory only. A projection of 'offline' and
 * no projection since this process started are the same state: the row then
 * returns to 'offline' when the last session here ends. The status a row shows
 * is never taken as a projection, because after a restart it may be the
 * 'online' a session here left behind.
 */

/** What this module needs to know about the sessions held here. */
export interface ReplicaSessionHost {
  /** A session of the user is open here, or its disconnect grace period runs. */
  hasSessionHere(userId: string): boolean;
  /** The status the user's sessions here publish with activity updates. */
  setUserStatus(userId: string, status: string): void;
}

const noSessions: ReplicaSessionHost = {
  hasSessionHere: () => false,
  setUserStatus: () => {},
};

let host: ReplicaSessionHost = noSessions;

// userId → the home's last projection, when it is not 'offline'.
const projections = new Map<string, ChosenUserStatus>();

/** Called once by the connection manager that holds the sessions. */
export function attachReplicaSessionHost(sessions: ReplicaSessionHost): void {
  host = sessions;
}

interface ReplicaRow extends StatusSourceRow {
  id: string;
}

/** The row of `userId` when it is a replicated one, else null. */
function replicaRow(userId: string): ReplicaRow | null {
  const row = getDb()
    .select({
      id: schema.users.id,
      homeInstance: schema.users.homeInstance,
      federationHomeOrphaned: schema.users.federationHomeOrphaned,
      chosenStatus: schema.users.chosenStatus,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!row || ownsChosenStatus(row)) return null;
  return row;
}

function writeShown(userId: string, status: UserStatus): void {
  getDb().update(schema.users).set({ status }).where(eq(schema.users.id, userId)).run();
  if (host.hasSessionHere(userId)) host.setUserStatus(userId, status);
}

/**
 * The home reported `projection` for `userId`: a presence relay, the profile
 * snapshot a stub is created or renamed with, or 'offline' when the peering
 * with the home ends. Records it and writes what the row shows
 * (`replicaLiveStatus`: 'online' for an 'offline' projection while a session
 * is here). Returns the shown status, or null when the row owns its status or
 * does not exist, in which case nothing is recorded or written.
 */
export function projectReplicaStatus(userId: string, projection: UserStatus): UserStatus | null {
  if (!replicaRow(userId)) return null;
  if (projection === 'offline') projections.delete(userId);
  else projections.set(userId, projection);
  const shown = replicaLiveStatus(projection, host.hasSessionHere(userId));
  writeShown(userId, shown);
  return shown;
}

/**
 * A session of replicated `row` authenticates here. Writes and returns the
 * status it shows (`statusOnConnect`): the known projection, else the status
 * the row shows now, with 'offline' read as 'online'. Records nothing.
 */
export function showReplicaStatusOnConnect(row: ReplicaRow): ChosenUserStatus {
  const shown = statusOnConnect(row, projections.get(row.id) ?? row.status);
  writeShown(row.id, shown);
  return shown;
}

/**
 * The replicated user chose `status` on this instance while a session is
 * here (`applyChosenStatus`). The choice belongs to the home, so it is shown
 * until the home's next projection or the end of the last session here, and
 * not recorded. Returns false, writing nothing, when the row owns its status.
 */
export function showReplicaChoice(userId: string, status: ChosenUserStatus): boolean {
  if (!replicaRow(userId)) return false;
  writeShown(userId, status);
  return true;
}

/**
 * The last session of `userId` here ended. A replicated row returns to the
 * home's known projection, or to 'offline' when none is known. Returns the
 * status the row shows now and whether that changed, or null when the row
 * owns its status (the caller writes 'offline' as for any native user).
 */
export function showReplicaStatusOnDisconnect(userId: string): { status: UserStatus; changed: boolean } | null {
  const row = replicaRow(userId);
  if (!row) return null;
  const status: UserStatus = projections.get(userId) ?? 'offline';
  const changed = row.status !== status;
  if (changed) getDb().update(schema.users).set({ status }).where(eq(schema.users.id, userId)).run();
  return { status, changed };
}

/** The row was tombstoned; its projection is dropped with it. */
export function forgetReplicaProjection(userId: string): void {
  projections.delete(userId);
}
