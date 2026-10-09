import { useCallback, useMemo, useState, type RefObject, type ChangeEvent, type KeyboardEvent } from 'react';
import { useSpaceStore } from '../../stores/spaceStore';
import { useComposerStore } from '../../stores/composerStore';
import { filterMentionCandidates, useChannelMentionCandidates, useSelfIdInChannel, useChannelUser, type ChannelUser } from '../../utils/channelUser';
import { getCanonicalUserView } from '../../utils/userViewLookup';
import { composerMentions } from './composerMentions';

interface MentionState { query: string; startIndex: number; selectedIndex: number }
interface Options { channelId: string; draftText: string; textareaRef: RefObject<HTMLTextAreaElement> }

/** Keep display offsets and wire IDs together; other composer features operate on wire drafts. */
export function useMentionComposer({ channelId, draftText, textareaRef }: Options) {
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const setDraft = useComposerStore(s => s.setDraft);
  const mentionCandidates = useChannelMentionCandidates(channelId);
  const selfId = useSelfIdInChannel(channelId);
  const self = useChannelUser(channelId, selfId ?? null);
  // Display resolution includes self even though DM autocomplete excludes self.
  useSpaceStore(state => state.userViews);
  const allRoles = useSpaceStore((state) => state.roles);
  const channelSpaceId = useSpaceStore((state) => state.channelToSpaceMap.get(channelId));
  // Use the channel roster so a DM never borrows labels from the last loaded space.
  const members = useMemo(() => mentionCandidates.flatMap((candidate) => candidate.member ? [candidate.member] : []), [mentionCandidates]);
  const mentionUsers = [...mentionCandidates, ...(self ? [self] : [])].map(candidate => getCanonicalUserView(candidate.user, candidate.origin));
  const roles = useMemo(() => allRoles.filter((role) => role.spaceId === channelSpaceId), [allRoles, channelSpaceId]);
  const mentionModel = useMemo(() => composerMentions({ value: draftText, members, roles, users: mentionUsers }), [draftText, members, roles, mentionUsers]);
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
      const insertion = `<@${candidate.userId}> `;
      const newContent = before + insertion + after;
      setDraft(channelId, newContent);
      setMentionState(null);

      // Restore cursor position after React re-renders
      const newCursorPos = composerMentions({ value: newContent, members, roles, users: mentionUsers }).toDisplay(before.length + insertion.length);
      requestAnimationFrame(() => {
        if (textarea) {
          textarea.focus();
          textarea.selectionStart = newCursorPos;
          textarea.selectionEnd = newCursorPos;
        }
      });
    },
    [mentionState, draftText, setDraft, channelId, mentionModel, members, roles, mentionUsers, textareaRef],
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
  const updateMention = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const change = mentionModel.update(e.target.value, e.target.selectionStart);
    const value = change.value;
    const nextModel = composerMentions({ value, members, roles, users: mentionUsers });
    const cursorPos = nextModel.toWire(change.cursor, true);
    // Atomic token deletion can shorten the visible value; keep the caret at the edit.
    if (!(e.nativeEvent as InputEvent).isComposing) {
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(change.cursor, change.cursor));
    }
    setDraft(channelId, value);

    // Detect @mention trigger
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([^\s<]*)$/);

    if (mentionMatch) {
      const atIndex = cursorPos - mentionMatch[0].length;
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
  return { mentionState, setMentionState, mentionMatches, mentionModel, members, roles, mentionUsers, selectMention, handleMentionKey, updateMention };
}
