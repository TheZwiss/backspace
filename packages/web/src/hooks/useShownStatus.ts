import type { User, UserStatus } from '@backspace/shared';
import { selectMyChosenStatus, useAuthStore, useSelfIdentity } from '../stores/authStore';
import { isMine } from '../utils/identity';

type Subject = Pick<User, 'id' | 'homeUserId' | 'homeInstance'>;

/**
 * The status to draw on a status dot that depicts `subject`, as the instance
 * at `origin` issued it.
 *
 * For the signed-in user (`isMine`: the row an instance named as theirs, or
 * any row naming the same person) it is the chosen status
 * (`selectMyChosenStatus`) once that is known, so the user's own status reads
 * the same everywhere it is shown for them (the user area, their own profile
 * card and profile) as it does for the alert gate and the settings panel. An
 * instance's view of the user can differ from the choice on a replicated
 * session (activity-presence.md, "The client's copy of the user's own
 * status"). For anyone else, and while the choice is not known, it is
 * `status` as given.
 */
export function useShownStatus<S extends UserStatus | null | undefined>(
  subject: Subject | null | undefined,
  origin: string,
  status: S,
): S | UserStatus {
  const self = useSelfIdentity();
  const chosen = useAuthStore(selectMyChosenStatus);
  if (!subject || !chosen || !isMine(subject, origin, self)) return status;
  return chosen;
}
