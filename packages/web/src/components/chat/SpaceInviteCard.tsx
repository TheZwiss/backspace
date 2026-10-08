import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { describeError } from '../../i18n/errors';
import { isAlreadyMemberError, isNotRequestableError, JoinRequestRequiredError } from '../../utils/joinErrors';
import { sendInviteJoinRequest, type InviteRequestOutcome } from '../../utils/inviteJoinRequest';
import { Avatar } from '../ui/Avatar';
import { getApiForOrigin } from '../../stores/spaceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import type { SpaceInviteSystemPayload, SpaceVisibility } from '@backspace/shared';

type LiveState =
  | { kind: 'loading' }
  /** `visibility` is absent when the space's instance predates it in the preview. */
  | { kind: 'confirmed'; memberCount: number; visibility?: SpaceVisibility }
  | { kind: 'revoked' };

interface Props {
  payload: SpaceInviteSystemPayload;
  senderName: string;
}

export function SpaceInviteCard({ payload, senderName }: Props) {
  const { t } = useTranslation(['chat']);
  const navigate = useNavigate();
  const joinByCode = useSpaceStore(s => s.joinByCode);
  const [live, setLive] = useState<LiveState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // A space joined by request: the card's action sends a join request, which
  // a manager approves; the code admits no one there. Known from the live
  // preview, or from a join the server answered with join_request_required.
  const [refusedJoin, setRefusedJoin] = useState(false);
  const [notRequestable, setNotRequestable] = useState(false);
  const [requestOutcome, setRequestOutcome] = useState<InviteRequestOutcome | null>(null);

  // Live-preview overlay: snapshot is authoritative until live confirms or
  // revokes it. A mismatched spaceId is treated as revoked because the invite
  // code now points to a different space than was captured at send time.
  useEffect(() => {
    let cancelled = false;
    const client = getApiForOrigin(payload.spaceInstanceOrigin);
    client.spaces.invitePreview(payload.inviteCode).then(
      (preview) => {
        if (cancelled) return;
        if (preview.spaceId !== payload.spaceId) {
          setLive({ kind: 'revoked' });
        } else {
          setLive({ kind: 'confirmed', memberCount: preview.memberCount, visibility: preview.visibility });
        }
      },
      () => { if (!cancelled) setLive({ kind: 'revoked' }); },
    );
    return () => { cancelled = true; };
  }, [payload.inviteCode, payload.spaceId, payload.spaceInstanceOrigin]);

  const memberCount = live.kind === 'confirmed' ? live.memberCount : payload.snapshot.memberCount;
  const isRevoked = live.kind === 'revoked';
  const asksToJoin = !notRequestable
    && (refusedJoin || (live.kind === 'confirmed' && live.visibility === 'request'));

  // Land the user at the space's channel sidebar after a successful join.
  // On mobile this means switching to the Spaces tab (which clears the chat
  // screen stack the invite was tapped from); on desktop it's just a route
  // change since AppLayout's auto-channel-redirect handles the rest. The
  // `setCurrentSpace` call seeds spaceStore synchronously so MobileSpacesScreen
  // mounts with the right space already selected, before AppLayout's URL effect
  // catches up.
  const landOnSpace = (spaceId: string) => {
    const ui = useUIStore.getState();
    if (ui.isMobile) {
      useSpaceStore.getState().setCurrentSpace(spaceId);
      ui.setMobileTab('spaces');
    }
    navigate(`/channels/${spaceId}`);
  };

  const join = async () => {
    try {
      // Three-way federation invariant: target the space's home origin, not
      // the DM transport origin nor window.location.origin. Empty string maps
      // to undefined so joinByCode follows its local-instance branch.
      const space = await joinByCode(payload.inviteCode, payload.spaceInstanceOrigin || undefined);
      landOnSpace(space.id);
    } catch (err) {
      if (isAlreadyMemberError(err)) {
        // Already a member is a successful state — just navigate to the space.
        // Look up the space in the store by id; if not found (rare race), stay
        // silent rather than block the user with a noisy error.
        landOnSpace(payload.spaceId);
        return;
      }
      if (err instanceof JoinRequestRequiredError) {
        // Offer the request; the user sends it with a second click.
        setRefusedJoin(true);
        setNotRequestable(false);
        setJoining(false);
        return;
      }
      setJoinError(err instanceof Error ? describeError(err) : t('chat:invite.joinFailed'));
      setJoining(false);
    }
  };

  const sendRequest = async () => {
    try {
      const outcome = await sendInviteJoinRequest(payload.spaceId, payload.spaceInstanceOrigin || '');
      setRequestOutcome(outcome);
      setJoining(false);
    } catch (err) {
      if (isAlreadyMemberError(err)) {
        landOnSpace(payload.spaceId);
        return;
      }
      if (isNotRequestableError(err)) {
        // The space stopped taking requests: the code follows its visibility.
        setNotRequestable(true);
        setRefusedJoin(false);
        await join();
        return;
      }
      setJoinError(describeError(err));
      setJoining(false);
    }
  };

  const onJoin = async () => {
    if (joining || isRevoked || requestOutcome) return;
    setJoining(true);
    setJoinError(null);
    if (asksToJoin) {
      await sendRequest();
    } else {
      await join();
    }
  };

  return (
    <div className={`my-1.5 max-w-md rounded-lg border border-white/[0.06] bg-surface-channel overflow-hidden ${isRevoked ? 'opacity-50' : ''}`}>
      <div className="px-3 py-1 text-[11px] text-txt-tertiary border-b border-white/[0.06]">
        {t('chat:invite.sentBy', { name: senderName })}
      </div>
      <div className="flex items-center gap-3 p-3">
        <Avatar
          src={payload.snapshot.icon}
          name={payload.snapshot.spaceName}
          size={48}
          userId={payload.spaceId}
          avatarColor={payload.snapshot.avatarColor}
          palette="space"
        />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-txt-primary truncate">
            {payload.snapshot.spaceName}
          </div>
          <div className="text-[12px] text-txt-tertiary truncate">
            {t('chat:invite.memberCount', { count: memberCount })}
            {payload.snapshot.instanceName ? ` · ${payload.snapshot.instanceName}` : ''}
            {live.kind === 'loading' && (
              <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-txt-tertiary animate-pulse" />
            )}
          </div>
        </div>
        {isRevoked ? (
          <span className="glass-pill px-3 py-1 text-[12px] text-txt-tertiary">
            {t('chat:invite.revoked')}
          </span>
        ) : requestOutcome ? (
          <span role="status" className="glass-pill px-3 py-1 text-[12px] text-accent-mint flex-shrink-0">
            {requestOutcome === 'sent' ? t('chat:invite.requestSent') : t('chat:invite.requestPending')}
          </span>
        ) : (
          <button
            onClick={onJoin}
            disabled={joining}
            className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 flex-shrink-0"
          >
            {asksToJoin
              ? (joining ? t('chat:invite.sendingRequest') : t('chat:invite.askToJoin'))
              : (joining ? t('chat:invite.joining') : t('chat:invite.join'))}
          </button>
        )}
      </div>
      {asksToJoin && !isRevoked && (
        <div className="px-3 pb-2 text-[12px] text-txt-tertiary">
          {requestOutcome ? t('chat:invite.requestReview') : t('chat:invite.requestNotice')}
        </div>
      )}
      {joinError && (
        <div className="px-3 pb-2 text-[12px] text-txt-danger">{joinError}</div>
      )}
    </div>
  );
}
