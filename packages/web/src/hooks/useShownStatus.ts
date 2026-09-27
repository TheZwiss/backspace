import type { User, UserStatus } from '@backspace/shared';
import { selectMyChosenStatus, useAuthStore } from '../stores/authStore';
import { isSelf } from '../utils/identity';

type Subject = Pick<User, 'id' | 'username' | 'homeInstance'>;

/**
 * The status to draw on a status dot that depicts `subject`.
 *
 * For the signed-in user it is the chosen status (`selectMyChosenStatus`) once
 * that is known, so the user's own status reads the same everywhere it is
 * shown for them (the user area, their own profile card and profile) as it
 * does for the alert gate and the settings panel. An instance's view of the
 * user can differ from the choice on a replicated session (activity-presence.md,
 * "The client's copy of the user's own status"). For anyone else, and while the
 * choice is not known, it is `status` as given.
 */
export function useShownStatus<S extends UserStatus | null | undefined>(
  subject: Subject | null | undefined,
  status: S,
): S | UserStatus {
  const me = useAuthStore((s) => s.user);
  const chosen = useAuthStore(selectMyChosenStatus);
  if (!subject || !chosen || !isSelf(subject, me)) return status;
  return chosen;
}
