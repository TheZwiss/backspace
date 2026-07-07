import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import type { Friend, MemberWithUser, SpaceInviteRequest, User } from '@backspace/shared';

type SendStatus =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'failure'; reason: string };

const FAILURE_COPY: Record<string, string> = {
  invite_invalid: 'Invite link no longer valid',
  not_a_friend: 'Not a friend',
  user_not_found: 'User not found',
  already_member: 'Already a member',
  upstream: "Couldn't verify invite — try again",
  cannot_invite_self: 'Cannot invite yourself',
  invalid_body: 'Invalid request',
  invalid_target: 'Invalid target',
};

function reasonForError(error: unknown): string {
  if (error instanceof Error) {
    // The api client throws Error(message) where message is the server's
    // `error` field (e.g. 'invite_invalid'). Fall back to message-based
    // network detection for transport failures.
    const msg = error.message;
    const mapped = FAILURE_COPY[msg];
    if (mapped) return mapped;
    if (/network|fetch|failed to fetch/i.test(msg)) {
      return "Couldn't reach your instance";
    }
  }
  return "Couldn't send (server error)";
}

function InviteResultFriendRow({
  friend,
  status,
}: {
  friend: Friend;
  status: SendStatus | undefined;
}) {
  const canonical = useCanonicalUserView(friend as unknown as User);
  const { baseName } = parseFederatedUsername(canonical.username);
  const dn = canonical.displayName ?? baseName;
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-[4px]">
      <Avatar
        src={canonical.avatar}
        name={dn}
        size={30}
        userId={canonical.homeUserId ?? canonical.id}
        avatarColor={canonical.avatarColor}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-txt-primary truncate">{dn}</div>
        <div className="text-[11px] text-txt-tertiary truncate">@{canonical.username}</div>
      </div>
      {status?.kind === 'success' && (
        <span className="text-[12px] text-accent-mint flex-shrink-0">✓ Sent</span>
      )}
      {status?.kind === 'failure' && (
        <span className="text-[12px] text-txt-danger flex-shrink-0">✗ {status.reason}</span>
      )}
      {status?.kind === 'pending' && (
        <span className="text-[12px] text-txt-tertiary flex-shrink-0">...</span>
      )}
    </div>
  );
}

function InviteSelectFriendRow({
  friend,
  isSelected,
  alreadyMember,
  sending,
  onToggle,
}: {
  friend: Friend;
  isSelected: boolean;
  alreadyMember: boolean;
  sending: boolean;
  onToggle: (id: string, friend: Friend) => void;
}) {
  const canonical = useCanonicalUserView(friend as unknown as User);
  const { baseName } = parseFederatedUsername(canonical.username);
  const dn = canonical.displayName ?? baseName;
  return (
    <button
      onClick={() => onToggle(friend.id, friend)}
      disabled={alreadyMember || sending}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[4px] transition-colors text-left ${
        alreadyMember
          ? 'opacity-40 cursor-not-allowed'
          : isSelected
            ? 'bg-accent-mint/[0.08]'
            : 'hover:bg-interactive-hover'
      }`}
    >
      <Avatar
        src={canonical.avatar}
        name={dn}
        size={30}
        status={canonical.status as any}
        userId={canonical.homeUserId ?? canonical.id}
        avatarColor={canonical.avatarColor}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-txt-primary truncate">{dn}</div>
        <div className="text-[11px] text-txt-tertiary truncate">
          {alreadyMember ? 'Already in space' : `@${canonical.username}`}
        </div>
      </div>
      {!alreadyMember && (
        <div
          className={`w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center ${
            isSelected ? 'bg-accent-mint' : 'border-2 border-border-hard'
          }`}
        >
          {isSelected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-surface-base">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}
    </button>
  );
}

export function InviteModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const generateInvite = useSpaceStore((s) => s.generateInvite);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const spaceMembers = useSpaceStore((s) => s.members);
  const friends = useSocialStore((s) => s.friends);
  const myUser = useAuthStore((s) => s.user);

  const isOpen = activeModal === 'invite';
  const currentSpace = spaces.find((s) => s.id === currentSpaceId);
  const instanceOrigin = currentSpace?._instanceOrigin ?? '';
  // Request-only spaces are approval-gated: they have no usable invite link and
  // the /invite endpoint 403s. Show an explanatory notice instead of the invite
  // affordances, and skip the invite-code fetch entirely.
  const isRequestOnly = currentSpace?.visibility === 'request';

  const [inviteCode, setInviteCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeLoading, setCodeLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Map<string, SendStatus>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  const inviteUrl = inviteCode
    ? `${instanceOrigin || window.location.origin}/join/${inviteCode}`
    : '';

  // Fetch / generate the per-space invite code on open.
  useEffect(() => {
    if (!isOpen || !currentSpaceId || isRequestOnly) return;
    setCodeLoading(true);
    setCodeError('');
    generateInvite(currentSpaceId).then(
      (code) => {
        setInviteCode(code);
        setCodeLoading(false);
      },
      (err) => {
        setCodeError((err as Error)?.message ?? 'Failed to generate invite link');
        setCodeLoading(false);
      },
    );
  }, [isOpen, currentSpaceId, generateInvite, isRequestOnly]);

  // Reset modal state on open.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected(new Set());
      setResults(new Map());
      setSending(false);
      setLinkCopied(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Federated-identity match per CLAUDE.md rule. The currently-loaded space's
  // member list lives on the store as `members: MemberWithUser[]`. Read the
  // federated identity tuple (user.homeUserId / user.homeInstance) on each side,
  // falling back to the local id for non-federated users.
  const isFriendAlreadyMember = (friend: Friend): boolean => {
    if (!currentSpace || spaceMembers.length === 0) return false;
    const fId = friend.homeUserId ?? friend.id;
    const fHome = friend.homeInstance ?? '';
    return spaceMembers.some((m: MemberWithUser) => {
      const mId = m.user.homeUserId ?? m.userId;
      const mHome = m.user.homeInstance ?? '';
      return mId === fId && mHome === fHome;
    });
  };

  const filteredFriends = useMemo(() => {
    const q = query.trim().toLowerCase();
    return friends.filter((f) => {
      if (isSelf(f, myUser)) return false;
      if (!q) return true;
      const dn = (f.displayName ?? '').toLowerCase();
      const un = f.username.toLowerCase();
      return dn.includes(q) || un.includes(q);
    });
  }, [friends, query, myUser]);

  const toggleFriend = (friendId: string, friend: Friend) => {
    if (isFriendAlreadyMember(friend)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(friendId)) next.delete(friendId);
      else next.add(friendId);
      return next;
    });
  };

  const removeFriend = (friendId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(friendId);
      return next;
    });
  };

  const selectedFriends = useMemo(
    () => friends.filter((f) => selected.has(f.id)),
    [friends, selected],
  );

  const sendInvitesTo = async (targets: Friend[]) => {
    if (!currentSpace || !inviteCode || targets.length === 0) return;
    setSending(true);

    // Mark all targets as pending in the results map (preserving prior successes).
    setResults((prev) => {
      const next = new Map(prev);
      for (const f of targets) next.set(f.id, { kind: 'pending' });
      return next;
    });

    const calls = targets.map(async (friend) => {
      const target: SpaceInviteRequest['target'] = friend.homeInstance
        ? {
            homeUserId: friend.homeUserId ?? friend.id,
            homeInstance: friend.homeInstance,
          }
        : { userId: friend.id };
      try {
        await api.dm.spaceInvite({
          target,
          spaceId: currentSpace.id,
          spaceInstanceOrigin: instanceOrigin,
          inviteCode,
        });
        return { friend, status: { kind: 'success' as const } };
      } catch (err) {
        return {
          friend,
          status: { kind: 'failure' as const, reason: reasonForError(err) },
        };
      }
    });

    const settled = await Promise.allSettled(calls);
    setResults((prev) => {
      const next = new Map(prev);
      for (const s of settled) {
        if (s.status === 'fulfilled') next.set(s.value.friend.id, s.value.status);
      }
      // If all targets succeeded, close the modal silently. Toast infra does
      // not exist in this codebase yet — see plan Task 12 / Step 2.
      const allSucceeded = targets.every(
        (f) => next.get(f.id)?.kind === 'success',
      );
      if (allSucceeded) {
        // Defer close until after this state batch settles.
        queueMicrotask(() => closeModal());
      }
      return next;
    });
    setSending(false);
  };

  const onSubmit = () => sendInvitesTo(selectedFriends);

  const onRetryFailed = () => {
    const failed = selectedFriends.filter(
      (f) => results.get(f.id)?.kind === 'failure',
    );
    sendInvitesTo(failed);
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* clipboard denied — silent */
    }
  };

  const inResultsView = results.size > 0 && !sending;
  const submitLabel =
    selectedFriends.length === 0
      ? 'Select Friends'
      : `Send ${selectedFriends.length} Invite${selectedFriends.length > 1 ? 's' : ''}`;
  const hasFailures =
    inResultsView &&
    selectedFriends.some((f) => results.get(f.id)?.kind === 'failure');

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title="Invite Friends"
      mobileStyle="sheet"
    >
      {isRequestOnly ? (
        <div className="space-y-3">
          <p className="text-[13px] text-txt-tertiary">
            This space uses join requests — people join by requesting approval
            from a manager, so it has no invite link to share.
          </p>
          <button
            onClick={closeModal}
            className="w-full py-2 rounded-md text-[13px] font-semibold glass-pill text-txt-primary"
          >
            Got it
          </button>
        </div>
      ) : (
      <div className="space-y-3">
        <p className="text-[13px] text-txt-tertiary">
          Send to friends, or share a link.
        </p>

        {/* Selected chips — hidden in results view */}
        {!inResultsView && selectedFriends.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {selectedFriends.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-accent-mint/15 text-accent-mint"
              >
                {f.displayName ?? parseFederatedUsername(f.username).baseName}
                <button
                  onClick={() => removeFriend(f.id)}
                  className="opacity-60 hover:opacity-100 transition-opacity text-[14px] leading-none"
                  aria-label={`Remove ${f.displayName ?? f.username}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search input — hidden in results view */}
        {!inResultsView && (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search friends..."
            className="input-search w-full py-2 text-[14px]"
          />
        )}

        {/* Friend list / Results view */}
        <div className="max-h-[280px] overflow-y-auto space-y-[2px]">
          {inResultsView ? (
            selectedFriends.map((f) => (
              <InviteResultFriendRow
                key={f.id}
                friend={f}
                status={results.get(f.id)}
              />
            ))
          ) : (
            <>
              {filteredFriends.length === 0 && (
                <div className="py-4 text-center text-txt-tertiary text-[14px]">
                  {query.trim()
                    ? 'No friends match your search'
                    : 'No friends yet'}
                </div>
              )}
              {filteredFriends.map((friend) => (
                <InviteSelectFriendRow
                  key={friend.id}
                  friend={friend}
                  isSelected={selected.has(friend.id)}
                  alreadyMember={isFriendAlreadyMember(friend)}
                  sending={sending}
                  onToggle={toggleFriend}
                />
              ))}
            </>
          )}
        </div>

        {/* Submit / Retry / Done */}
        {inResultsView ? (
          <div className="flex gap-2">
            {hasFailures && (
              <button
                onClick={onRetryFailed}
                disabled={sending}
                className="flex-1 py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Retry failed
              </button>
            )}
            <button
              onClick={closeModal}
              className="flex-1 py-2 rounded-md text-[13px] font-semibold glass-pill text-txt-primary"
            >
              Done
            </button>
          </div>
        ) : (
          <button
            onClick={onSubmit}
            disabled={selectedFriends.length === 0 || sending || codeLoading}
            className="w-full py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending...' : submitLabel}
          </button>
        )}

        {/* Share-link footer */}
        <div className="pt-3 border-t border-white/[0.06]">
          <p className="text-[12px] text-txt-tertiary mb-2">
            Or share a link
          </p>
          {codeError && (
            <div className="mb-2 text-[12px] text-txt-danger">{codeError}</div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={codeLoading ? 'Generating...' : inviteUrl}
              readOnly
              className="input-embedded flex-1 font-mono text-xs px-2 py-1.5"
            />
            <button
              onClick={handleCopy}
              disabled={codeLoading || !inviteUrl}
              className={`glass-pill px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                linkCopied ? 'text-accent-mint' : 'text-txt-primary'
              }`}
            >
              {linkCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
      )}
    </Modal>
  );
}
