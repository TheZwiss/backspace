import type { DmChannel } from '@backspace/shared';

/**
 * DM channel fixtures in the shapes servers really send.
 *
 * Current servers put every `DmChannel` on the wire through one serializer
 * (server `utils/dmChannelWire.ts`), so ready, `GET /api/dm` and
 * `dm_channel_created` all carry the conversation key and the group metadata.
 * Servers up to 1.6.1 sent `GET /api/dm` entries without them; a client still
 * lists DMs from peers on those versions.
 */

/** A DM exactly as a current server sends it: every nullable field present. */
export function wireDm(fields: Pick<DmChannel, 'id' | 'createdAt' | 'members'> & Partial<DmChannel>): DmChannel {
  return {
    federatedId: null,
    ownerId: null,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 0,
    lastMessage: null,
    ...fields,
  };
}

/**
 * The same DM as `GET /api/dm` on a 1.6.1 (or older) server lists it: without
 * the conversation key, the owner's home identity, name, icon and
 * metadataUpdatedAt. Typed as `DmChannel` because that is what the client's
 * API layer claims to receive.
 */
export function asListedBy161(dm: DmChannel): DmChannel {
  const listed: Partial<DmChannel> = { ...dm };
  delete listed.federatedId;
  delete listed.ownerHomeUserId;
  delete listed.ownerHomeInstance;
  delete listed.name;
  delete listed.icon;
  delete listed.metadataUpdatedAt;
  return listed as DmChannel;
}

/** Deep copy, so a fake API never hands out the fixture objects themselves. */
export function copyDm(dm: DmChannel): DmChannel {
  return { ...dm, members: dm.members.map(m => ({ ...m })) };
}
