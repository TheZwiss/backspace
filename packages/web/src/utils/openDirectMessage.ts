import { useSpaceStore } from '../stores/spaceStore';
import { getApiForOrigin } from './crossStoreResolvers';
import { personRequest, type IdentityFields } from './identity';

/**
 * Open the 1-on-1 DM with the person `row` names, as the instance at `origin`
 * issued the row, creating it when there is none. Resolves to the channel id
 * of the conversation's row, which is where the UI navigates. Throws when the
 * create request fails; the caller reports it.
 *
 * The one path every "Send Message" takes, so which person a DM is with is
 * decided once (`userKey` for the lookup, `personRequest` for the request).
 */
export async function openDirectMessage(row: IdentityFields, origin: string): Promise<string> {
  const store = useSpaceStore.getState();
  const existing = store.findExistingDmForUser(row, origin);
  if (existing) return existing.dm.id;
  const request = personRequest(row, origin);
  const channel = await getApiForOrigin(request.origin).dm.create(request.target);
  // The answer joins its conversation; its row is where the UI goes.
  return store.upsertDmCopy(request.origin, channel, 'stated');
}
