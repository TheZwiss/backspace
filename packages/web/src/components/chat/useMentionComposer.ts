import { useCallback, useMemo, useState, type RefObject, type ChangeEvent, type KeyboardEvent } from 'react';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import {
  filterMentionCandidates,
  useChannelMentionCandidates,
  useChannelUserResolver,
  type ChannelUser,
} from '../../utils/channelUser';
import { spaceMemberName } from '../../utils/identity';
import { composerMentions, mentionInsertion, type ComposerMentions } from './composerMentions';
import { placeCaret } from './placeCaret';

interface MentionState {
  query: string;
  /** Draft offset of the typed `@`. */
  startIndex: number;
  selectedIndex: number;
}

interface Options {
  channelId: string;
  draftText: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
}

/**
 * The composer's mention handling: the picker's state and keys, and the map
 * between the stored draft (wire `<@id>` and `<@&id>` tokens) and the text the
 * textarea shows (`@name`). The draft stays in wire form; every other composer feature
 * works on it and converts textarea offsets with `mentionModel`.
 */
export function useMentionComposer({ channelId, draftText, textareaRef }: Options) {
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const setDraft = useComposerStore((s) => s.setDraft);
  const mentionCandidates = useChannelMentionCandidates(channelId);
  // Labels come from the channel's people, as the sent message's badges do,
  // so a DM shows its own members (the signed-in user included) and never the
  // roster of the space loaded last.
  const resolveUser = useChannelUserResolver(channelId);
  // Role labels come from the channel's own space, as MassMentionBadge
  // resolves them in the sent message; a DM has none.
  const spaceId = useSpaceStore((s) => s.channelToSpaceMap.get(channelId));
  const roles = useSpaceStore((s) => s.roles);
  const modelFor = useCallback(
    (value: string): ComposerMentions =>
      composerMentions(
        value,
        (userId) => {
          const found = resolveUser(userId);
          // The name the sent message's MentionBadge shows: the space
          // nickname where there is one.
          return found ? spaceMemberName(found.member, found.user) : null;
        },
        (roleId) => {
          const role = spaceId === undefined ? undefined : roles.find((r) => r.id === roleId && r.spaceId === spaceId);
          return role ? role.name.replace(/^@/, '') : null;
        },
      ),
    [resolveUser, spaceId, roles],
  );
  const mentionModel = useMemo(() => modelFor(draftText), [modelFor, draftText]);
  // The popover's rows; keyboard navigation indexes the same list.
  const mentionMatches = useMemo(
    () => (mentionState ? filterMentionCandidates(mentionCandidates, mentionState.query) : []),
    [mentionCandidates, mentionState],
  );

  const selectMention = useCallback(
    (candidate: ChannelUser) => {
      if (!mentionState) return;
      const textarea = textareaRef.current;
      const cursorPos = textarea ? mentionModel.toWire(textarea.selectionStart, true) : draftText.length;
      const before = draftText.slice(0, mentionState.startIndex);
      const after = draftText.slice(cursorPos);
      const insertion = mentionInsertion(candidate.userId);
      const newContent = before + insertion + after;
      setDraft(channelId, newContent);
      setMentionState(null);

      // Restore cursor position after React re-renders
      placeCaret(textareaRef, modelFor(newContent).toDisplay(before.length + insertion.length), true);
    },
    [mentionState, draftText, setDraft, channelId, mentionModel, modelFor, textareaRef],
  );

  const handleMentionKey = (e: KeyboardEvent): boolean => {
    // Mention popover keyboard navigation
    if (mentionState && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, mentionMatches.length - 1) } : null,
        );
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) } : null,
        );
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = mentionMatches[mentionState.selectedIndex];
        if (selected) selectMention(selected);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(null);
        return true;
      }
    }

    return false;
  };

  /** The textarea changed: store the draft it now means and open or close the picker. */
  const updateMention = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const { value, wireCursor } = mentionModel.update(e.target.value, e.target.selectionStart);
    const shown = modelFor(value);
    // When the edit touched a mention, the whole token went and the shown text
    // is not what the textarea holds. React then writes the new text and the
    // browser puts the caret at the end; put it back at the edit. An ordinary
    // edit leaves the caret alone, so the keyboard's own state is not reset,
    // and a running IME composition is never interrupted.
    if (shown.text !== e.target.value && !(e.nativeEvent as InputEvent).isComposing) {
      placeCaret(textareaRef, shown.toDisplay(wireCursor));
    }
    setDraft(channelId, value);

    // Detect @mention trigger
    const textBeforeCursor = value.slice(0, wireCursor);
    const mentionMatch = textBeforeCursor.match(/@([^\s<]*)$/);

    if (mentionMatch) {
      const atIndex = wireCursor - mentionMatch[0].length;
      // Only trigger at word boundary: start of input, after space, or after newline
      const charBefore = atIndex > 0 ? value[atIndex - 1] : undefined;
      if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
        setMentionState({
          query: mentionMatch[1] ?? '',
          startIndex: atIndex,
          selectedIndex: 0,
        });
      } else {
        setMentionState(null);
      }
    } else {
      setMentionState(null);
    }
  };

  return { mentionState, setMentionState, mentionMatches, mentionModel, modelFor, selectMention, handleMentionKey, updateMention };
}
