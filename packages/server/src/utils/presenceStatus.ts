import { isChosenUserStatus, ownsChosenStatus, type ChosenUserStatus } from '@backspace/shared';

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
 * The status to publish when a connection for this user authenticates.
 *
 * - A row that owns its choice (native or detached, `ownsChosenStatus`): the
 *   user's chosen status.
 * - A replicated row: this instance does not own the user's choice, so its own
 *   `chosen_status` copy is ignored. The live `status` holds the home
 *   instance's last projection (S2S `presence_update`), which is kept; only
 *   when it says 'offline' (no projection yet, or it was cleared by this
 *   instance's own disconnect) does the new connection fall back to 'online'.
 */
export function statusOnConnect(row: StatusSourceRow): ChosenUserStatus {
  if (ownsChosenStatus(row)) {
    return isChosenUserStatus(row.chosenStatus) ? row.chosenStatus : 'online';
  }
  return isChosenUserStatus(row.status) ? row.status : 'online';
}
