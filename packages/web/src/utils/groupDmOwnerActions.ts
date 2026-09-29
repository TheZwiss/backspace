import type { DmChannel, User } from '@backspace/shared';
import type { BackspaceApiClient, DmMemberTarget } from '../api/client';
import { getChannelOrigin, dmCopyIdOnOrigin, getOwnerInstanceForDm } from '../stores/spaceStore';
import { getApiForOrigin, resolveOriginFromHostname } from './crossStoreResolvers';
import { deliveringHost, normalizeOriginToHost } from './identity';
import i18n from '../i18n';

/**
 * Owner-only group DM requests: rename or re-icon, remove a member, transfer
 * ownership. Each goes to the owner's home instance, so the relay event it
 * causes comes from the instance receivers accept it from
 * (`dm_channels.owner_home_instance`). A request to an instance names the
 * conversation, and the member it acts on, as that instance's own copy does:
 * the row the client shows (`channelId`) may be another instance's copy,
 * whose ids mean nothing there. See docs/systems/dm-system.md,
 * "Owner-Only Requests".
 */

/** The owner's instance is not connected, or does not list the conversation for this user. */
export class OwnerInstanceUnavailableError extends Error {
  constructor(public readonly host: string, public readonly reason: 'not_connected' | 'not_listed') {
    super(reason === 'not_connected'
      ? i18n.t('dm:ownerActions.ownerNotConnected', { host })
      : i18n.t('dm:ownerActions.ownerNotListed', { host }));
    this.name = 'OwnerInstanceUnavailableError';
  }
}

interface OwnerRoute {
  client: BackspaceApiClient;
  /** The owner instance's id for the conversation. */
  channelId: string;
  /** Whether that is the instance whose copy the client shows. */
  sameInstance: boolean;
  /** The origin of the shown copy (`''` for the page's instance). */
  shownOrigin: string;
}

/**
 * The client origin (`''` for the page's instance) of the owner's home, or
 * throws when it is an instance the client is not connected to.
 */
function ownerOrigin(channelId: string): string {
  const host = normalizeOriginToHost(getOwnerInstanceForDm(channelId));
  // No owner instance recorded: a group no other instance holds, owned here.
  if (!host || host === deliveringHost('')) return '';
  const origin = resolveOriginFromHostname(host);
  if (!origin) throw new OwnerInstanceUnavailableError(host, 'not_connected');
  return origin;
}

function ownerRoute(channelId: string): OwnerRoute {
  const target = ownerOrigin(channelId);
  const shownOrigin = getChannelOrigin(channelId);
  if (target === shownOrigin) {
    return { client: getApiForOrigin(target), channelId, sameInstance: true, shownOrigin };
  }
  const copyId = dmCopyIdOnOrigin(channelId, target);
  if (!copyId) throw new OwnerInstanceUnavailableError(deliveringHost(target), 'not_listed');
  return { client: getApiForOrigin(target), channelId: copyId, sameInstance: false, shownOrigin };
}

/**
 * `member` (a user from the shown copy's roster) as the owner's instance can
 * find them. A member homed elsewhere is named by their home identity, which
 * every instance resolves. A member native to the shown instance is named by
 * their local id there when that is the owner's instance, and otherwise by
 * that id with the shown instance's host, which is their home identity.
 */
function memberTarget(member: Pick<User, 'id' | 'homeUserId' | 'homeInstance'>, route: OwnerRoute): DmMemberTarget {
  if (member.homeUserId && member.homeInstance) {
    return { homeUserId: member.homeUserId, homeInstance: member.homeInstance };
  }
  if (route.sameInstance) return { userId: member.id };
  return { homeUserId: member.id, homeInstance: deliveringHost(route.shownOrigin) };
}

/** Rename a group DM and/or change its icon. */
export async function updateGroupDmMetadata(
  channelId: string,
  body: { name?: string | null; icon?: string | null },
): Promise<DmChannel> {
  const route = ownerRoute(channelId);
  return route.client.dm.updateMetadata(route.channelId, body);
}

/** Remove `member` from a group DM. */
export async function kickFromGroupDm(
  channelId: string,
  member: Pick<User, 'id' | 'homeUserId' | 'homeInstance'>,
): Promise<{ success: boolean }> {
  const route = ownerRoute(channelId);
  return route.client.dm.kickMember(route.channelId, memberTarget(member, route));
}

/** Make `member` the owner of a group DM. */
export async function transferGroupDmOwnership(
  channelId: string,
  member: Pick<User, 'id' | 'homeUserId' | 'homeInstance'>,
): Promise<DmChannel> {
  const route = ownerRoute(channelId);
  return route.client.dm.transferOwnership(route.channelId, memberTarget(member, route));
}
