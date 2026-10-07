import { isChosenUserStatus, ownsChosenStatus, type ChosenUserStatus, type UserStatus } from '@backspace/shared';

/**
 * Presence status rules shared by the socket auth path and the manual-change
 * path. Pure: no database or connection access, so it can be imported from
 * ws/handler.ts without a cycle. The two columns and which rows own a choice
 * are described in activity-presence.md, "DB Persistence".
 */

export interface StatusSourceRow {
  homeInstance: string | null;
  federationHomeOrphaned: number | null;
  chosenStatus: string;
  status: string | null;
}

/**
 * The live status of a replicated row (one that does not own its choice):
 * the home instance's projection (S2S `presence_update`), except that while
 * this instance holds a session of the user a projection of 'offline' reads
 * 'online'. ws/replicaPresence.ts is the one writer that applies it.
 */
export function replicaLiveStatus(projection: string | null, connectedHere: boolean): UserStatus {
  if (isChosenUserStatus(projection)) return projection;
  return connectedHere ? 'online' : 'offline';
}

/**
 * The status to publish when a connection for this user authenticates.
 *
 * - A row that owns its choice (native or detached, `ownsChosenStatus`): the
 *   user's chosen status.
 * - A replicated row: this instance does not own the user's choice, so its own
 *   `chosen_status` copy is ignored; `projection` is the home's projection
 *   when known, else the status the row shows (`showReplicaStatusOnConnect`),
 *   with 'offline' read as 'online' (`replicaLiveStatus` with a session here).
 */
export function statusOnConnect(row: StatusSourceRow, projection: string | null = row.status): ChosenUserStatus {
  if (ownsChosenStatus(row)) {
    return isChosenUserStatus(row.chosenStatus) ? row.chosenStatus : 'online';
  }
  return isChosenUserStatus(projection) ? projection : 'online';
}
