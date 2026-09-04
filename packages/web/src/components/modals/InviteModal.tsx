import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { describeError } from '../../i18n/errors';
import type { Friend, MemberWithUser, SpaceInviteRequest, User } from '@backspace/shared';

type SendStatus =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'failure'; reason: string };

type InviteT = TFunction<['spaces', 'common']>;

/**
 * The invite relay answers with a bare reason in its `error` field. These
 * are not `ErrorCode`s yet, so the wording lives in the spaces catalog
 * until the server-side error-code pass reaches the DM routes.
 */
function reasonForError(error: unknown, t: InviteT): string {
  if (error instanceof Error) {
    const msg = error.message;
    switch (msg) {
      case 'invite_invalid': return t('spaces:invite.failure.inviteInvalid');
      case 'not_a_friend': return t('spaces:invite.failure.notAFriend');
      case 'user_not_found': return t('spaces:invite.failure.userNotFound');
      case 'already_member': return t('spaces:invite.failure.alreadyMember');
      case 'upstream': return t('spaces:invite.failure.upstream');
      case 'cannot_invite_self': return t('spaces:invite.failure.cannotInviteSelf');
      case 'invalid_body': return t('spaces:invite.failure.invalidBody');
      case 'invalid_target': return t('spaces:invite.failure.invalidTarget');
      default:
        break;
    }
    if (/network|fetch|failed to fetch/i.test(msg)) {
      return t('spaces:invite.failure.unreachable');
    }
  }
  return t('spaces:invite.failure.serverError');
}

function InviteResultFriendRow({
  friend,
  status,
}: {
  friend: Friend;
  status: SendStatus | undefined;
}) {
  const { t } = useTranslation(['spaces', 'common']);
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
        <span className="text-[12px] text-accent-mint flex-shrink-0">{t('spaces:invite.status.sent')}</span>
      )}
      {status?.kind === 'failure' && (
        <span className="text-[12px] text-txt-danger flex-shrink-0">{t('spaces:invite.status.failed', { reason: status.reason })}</span>
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
  const { t } = useTranslation(['spaces', 'common']);
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
          {alreadyMember ? t('spaces:invite.alreadyMember') : `@${canonical.username}`}
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
  const { t } = useTranslation(['spaces', 'common']);
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
        setCodeError(describeError(err));
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
          status: { kind: 'failure' as const, reason: reasonForError(err, t) },
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
      ? t('spaces:invite.selectFriends')
      : t('spaces:invite.send', { count: selectedFriends.length });
  const hasFailures =
    inResultsView &&
    selectedFriends.some((f) => results.get(f.id)?.kind === 'failure');

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={t('spaces:invite.title')}
      mobileStyle="sheet"
    >
      {isRequestOnly ? (
        <div className="space-y-3">
          <p className="text-[13px] text-txt-tertiary">
            {t('spaces:invite.requestOnly.notice')}
          </p>
          <button
            onClick={closeModal}
            className="w-full py-2 rounded-md text-[13px] font-semibold glass-pill text-txt-primary"
          >
            {t('spaces:invite.requestOnly.dismiss')}
          </button>
        </div>
      ) : (
      <div className="space-y-3">
        <p className="text-[13px] text-txt-tertiary">
          {t('spaces:invite.intro')}
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
                  aria-label={t('spaces:invite.removeSelected', { name: f.displayName ?? f.username })}
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
            placeholder={t('spaces:invite.searchPlaceholder')}
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
                    ? t('spaces:invite.noMatches')
                    : t('spaces:invite.noFriends')}
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
                {t('spaces:invite.retryFailed')}
              </button>
            )}
            <button
              onClick={closeModal}
              className="flex-1 py-2 rounded-md text-[13px] font-semibold glass-pill text-txt-primary"
            >
              {t('common:actions.done')}
            </button>
          </div>
        ) : (
          <button
            onClick={onSubmit}
            disabled={selectedFriends.length === 0 || sending || codeLoading}
            className="w-full py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? t('spaces:invite.sending') : submitLabel}
          </button>
        )}

        {/* Share-link footer */}
        <div className="pt-3 border-t border-white/[0.06]">
          <p className="text-[12px] text-txt-tertiary mb-2">
            {t('spaces:invite.shareLink')}
          </p>
          {codeError && (
            <div className="mb-2 text-[12px] text-txt-danger">{codeError}</div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={codeLoading ? t('spaces:invite.generating') : inviteUrl}
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
              {linkCopied ? t('common:actions.copied') : t('common:actions.copy')}
            </button>
          </div>
        </div>
      </div>
      )}
    </Modal>
  );
}
