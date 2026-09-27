import type { User, UserStatus } from '@backspace/shared';
import { selectMyChosenStatus, useAuthStore } from '../stores/authStore';
import { isRegisteredSelfId } from '../utils/identity';

type Subject = Pick<User, 'id'>;

/**
 * The status to draw on a status dot that depicts `subject`.
 *
 * For the signed-in user (the session row, or a row a connected instance
 * reported as the user's own) it is the chosen status (`selectMyChosenStatus`)
 * once that is known, so the user's own status reads the same everywhere it is
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
  if (!subject || !chosen || !me) return status;
  // Only a row proven to be the user's own: the session row itself, or a row a
  // connected instance's `ready` named as the user. `isSelf`'s username
  // fallback is not used: when the session is itself a replicated row it
  // matches a different person who shares the name (erin@nova signed in on
  // orbit, and orbit's own erin as nova shows her).
  if (subject.id !== me.id && !isRegisteredSelfId(subject.id)) return status;
  return chosen;
}
