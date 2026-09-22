import type { TFunction } from 'i18next';

/**
 * Why a connection in the federation registry is not usable, as this client
 * records it on `FederationRegistryEntry.errorMessage`.
 *
 * The field is a free string on the wire (it is synced to the home instance
 * and back), and it used to hold an English sentence written at the point of
 * failure, which the Connections row then rendered as it stood. A user
 * reading the app in German, Russian or Chinese got that sentence in English.
 * A code stored instead is the same contract the server already uses for its
 * errors: the value on the wire is machine-readable and the client owns the
 * words.
 *
 * These are not `ErrorCode`s. Nothing throws them, no route sends them, and
 * `ERROR_MESSAGES` on the server is exhaustive over `ErrorCode`, so minting
 * one there would mean an English sentence in the server package for a string
 * only this client ever writes and only this client ever reads.
 */
export type RegistryErrorReason =
  /** The instance did not answer; the token may well still be good. */
  | 'unreachable'
  /** A session that existed was refused: the saved token is no longer valid. */
  | 'session_expired'
  /** A known connection with no session yet, which re-authentication opens. */
  | 'reauthenticate'
  /** The same, for the home instance of a federated account. */
  | 'authenticate_home';

/**
 * The stored spelling of a reason, checked against the union at the call
 * site so a typo in a store write is a compile error rather than a row that
 * silently renders its own code.
 */
export function registryReason(reason: RegistryErrorReason): string {
  return reason;
}

/**
 * The words for a stored reason.
 *
 * A value that is not a reason this client writes is rendered as it stands:
 * an entry synced from a client on an older version carries the English
 * sentence that version wrote, and showing it is better than dropping the
 * only explanation the row has. The keys are named here rather than built
 * from the value, which is also what keeps the i18n check able to see them.
 */
export function describeRegistryError(t: TFunction<['federation', 'common']>, stored: string): string {
  switch (stored) {
    case 'unreachable': return t('federation:connections.row.reason.unreachable');
    case 'session_expired': return t('federation:connections.row.reason.sessionExpired');
    case 'reauthenticate': return t('federation:connections.row.reason.reauthenticate');
    case 'authenticate_home': return t('federation:connections.row.reason.authenticateHome');
    default: return stored;
  }
}
