/**
 * Decides whether a freshly-arrived chat message should fire the in-app
 * `message.mp3` cue. Pure, federation-aware (matches against any of the
 * caller's known self-ids).
 *
 * Rule (Discord-default):
 *   - Suppress messages authored by self (any id in myIds).
 *   - When allChannels=true, fire for every non-self message.
 *   - Otherwise, fire only if the channel is a DM, or if the content contains
 *     a `<@${id}>` mention for any id in myIds.
 */
export interface ShouldPlayMessageSoundInput {
  authorUserId: string;
  myIds: Set<string>;
  isDmChannel: boolean;
  content: string | null;
  allChannels: boolean;
}

export function shouldPlayMessageSound(input: ShouldPlayMessageSoundInput): boolean {
  if (input.myIds.has(input.authorUserId)) return false;
  if (input.allChannels) return true;
  if (input.isDmChannel) return true;
  if (!input.content) return false;
  for (const id of input.myIds) {
    if (input.content.includes(`<@${id}>`)) return true;
  }
  return false;
}
