import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSelfIdentity } from '../../stores/authStore';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { HttpError } from '../../api/client';
import { getFriendsHomeOrigin } from '../../stores/instanceStore';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';
import { isMine, parseFederatedUsername, personRequest, userKey } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { describeError } from '../../i18n/errors';
import type { MemberWithUser, SpaceInviteRequest, User } from '@backspace/shared';

type SendStatus =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'failure'; reason: string };

type InviteT = TFunction<['spaces', 'common']>;

/**
 * The person a friend row names (`userKey`). Friends come from every
 * connected instance, whose row ids can coincide, so selection and results
 * are keyed by person.
 */
function friendKey(friend: TaggedFriend): string {
  return userKey(friend, friend._instanceOrigin);
}

/**
 * How the instance at `to` is told who the invite is for: the friend's id
 * there when they are native to it, else their home identity
 * (`personRequest`). Null for a legacy stub another instance issued, which
 * cannot be named to `to`.
 */
function inviteTarget(friend: TaggedFriend, to: string): SpaceInviteRequest['target'] | null {
  const request = personRequest(friend, friend._instanceOrigin, to);
  if (request.origin !== to) return null;
  const { userId, homeUserId, homeInstance } = request.target;
  if (homeUserId && homeInstance) return { homeUserId, homeInstance };
  return userId ? { userId } : null;
}

/**
 * The space's instance as the instance at `to` reads it. `''` on the wire
 * means the receiving server's own space, so it is sent only when the space
 * is on `to`; a space on the page's own instance (`spaceOrigin` `''`) is
 * named by the page's origin when the invite goes elsewhere.
 */
function spaceOriginFor(spaceOrigin: string, to: string): string {
  if (spaceOrigin === to) return '';
  return spaceOrigin || window.location.origin;
}

/**
 * Row-sized copy for each way a space invite can fail. Keyed on the server's
 * error code; the two message checks below cover a failed fetch and the
 * client-side "upstream" marker, which never carry a code.
 */
function reasonForError(error: unknown, t: InviteT): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case 'invite_invalid': return t('spaces:invite.failure.inviteInvalid');
      case 'not_a_friend': return t('spaces:invite.failure.notAFriend');
      case 'user_not_found': return t('spaces:invite.failure.userNotFound');
      case 'already_member': return t('spaces:invite.failure.alreadyMember');
      case 'cannot_invite_self': return t('spaces:invite.failure.cannotInviteSelf');
      case 'invalid_body': return t('spaces:invite.failure.invalidBody');
      case 'invalid_target': return t('spaces:invite.failure.invalidTarget');
      default:
        break;
    }
  }
  if (error instanceof Error) {
    if (error.message === 'upstream') {
      return t('spaces:invite.failure.upstream');
    }
    if (/network|fetch|failed to fetch/i.test(error.message)) {
      return t('spaces:invite.failure.unreachable');
    }
  }
  return t('spaces:invite.failure.serverError');
}

function InviteResultFriendRow({
  friend,
  status,
}: {
  friend: TaggedFriend;
  status: SendStatus | undefined;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  const canonical = useCanonicalUserView(friend as unknown as User, friend._instanceOrigin);
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
  friend: TaggedFriend;
  isSelected: boolean;
  alreadyMember: boolean;
  sending: boolean;
  onToggle: (key: string, friend: TaggedFriend) => void;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  const canonical = useCanonicalUserView(friend as unknown as User, friend._instanceOrigin);
  const { baseName } = parseFederatedUsername(canonical.username);
  const dn = canonical.displayName ?? baseName;
  return (
    <button
      onClick={() => onToggle(friendKey(friend), friend)}
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
  const self = useSelfIdentity();

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
  const isFriendAlreadyMember = (friend: TaggedFriend): boolean => {
    if (!currentSpace || spaceMembers.length === 0) return false;
    // The same person (`userKey`), whichever instance's row each list holds.
    const key = userKey(friend, friend._instanceOrigin);
    const spaceOrigin = currentSpace._instanceOrigin ?? '';
    return spaceMembers.some((m: MemberWithUser) => userKey(m.user, spaceOrigin) === key);
  };

  const filteredFriends = useMemo(() => {
    const q = query.trim().toLowerCase();
    return friends.filter((f) => {
      if (isMine(f, f._instanceOrigin, self)) return false;
      if (!q) return true;
      const dn = (f.displayName ?? '').toLowerCase();
      const un = f.username.toLowerCase();
      return dn.includes(q) || un.includes(q);
    });
  }, [friends, query, self]);

  const toggleFriend = (key: string, friend: TaggedFriend) => {
    if (isFriendAlreadyMember(friend)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeFriend = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const selectedFriends = useMemo(
    () => friends.filter((f) => selected.has(friendKey(f))),
    [friends, selected],
  );

  const sendInvitesTo = async (targets: TaggedFriend[]) => {
    if (!currentSpace || !inviteCode || targets.length === 0) return;
    setSending(true);

    // Mark all targets as pending in the results map (preserving prior successes).
    setResults((prev) => {
      const next = new Map(prev);
      for (const f of targets) next.set(friendKey(f), { kind: 'pending' });
      return next;
    });

    // Invites go to the user's home (`getFriendsHomeOrigin`), whose friend
    // list they are checked against and whose copy of each 1-on-1 the user
    // reads; on a session signed in to another instance that is a secondary
    // connection, not the page's own instance.
    const home = getFriendsHomeOrigin();
    const homeApi = getApiForOrigin(home);
    const spaceInstanceOrigin = spaceOriginFor(instanceOrigin, home);
    const calls = targets.map(async (friend) => {
      const target = inviteTarget(friend, home);
      if (!target) {
        return {
          friend,
          status: { kind: 'failure' as const, reason: t('spaces:invite.failure.invalidTarget') },
        };
      }
      try {
        await homeApi.dm.spaceInvite({
          target,
          spaceId: currentSpace.id,
          spaceInstanceOrigin,
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
        if (s.status === 'fulfilled') next.set(friendKey(s.value.friend), s.value.status);
      }
      // If all targets succeeded, close the modal silently. Toast infra does
      // not exist in this codebase yet — see plan Task 12 / Step 2.
      const allSucceeded = targets.every(
        (f) => next.get(friendKey(f))?.kind === 'success',
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
      (f) => results.get(friendKey(f))?.kind === 'failure',
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
    selectedFriends.some((f) => results.get(friendKey(f))?.kind === 'failure');

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
                key={friendKey(f)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-accent-mint/15 text-accent-mint"
              >
                {f.displayName ?? parseFederatedUsername(f.username).baseName}
                <button
                  onClick={() => removeFriend(friendKey(f))}
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
                key={friendKey(f)}
                friend={f}
                status={results.get(friendKey(f))}
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
                  key={friendKey(friend)}
                  friend={friend}
                  isSelected={selected.has(friendKey(friend))}
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
