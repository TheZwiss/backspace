import type { Role } from '@backspace/shared';

/**
 * A bot's managed role (bots.md, "Permissions on invite"): created for one bot
 * when a manager added it, held by that bot alone, never given to anyone else
 * and never deleted on its own; it goes when the bot leaves the space. The
 * server enforces this; these helpers keep the role editors from offering it.
 */
export function isBotManagedRole(role: Pick<Role, 'managedBotId'>): boolean {
  return typeof role.managedBotId === 'string' && role.managedBotId.length > 0;
}

/** Whether a member's role editor lists `role` for `memberId`: any role but another bot's managed one. */
export function isListedForMember(role: Pick<Role, 'managedBotId'>, memberId: string): boolean {
  return !isBotManagedRole(role) || role.managedBotId === memberId;
}
