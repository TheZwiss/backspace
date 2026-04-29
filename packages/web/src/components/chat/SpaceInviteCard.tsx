import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../ui/Avatar';
import { getApiForOrigin } from '../../stores/spaceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import type { SpaceInviteSystemPayload } from '@backspace/shared';

type LiveState =
  | { kind: 'loading' }
  | { kind: 'confirmed'; memberCount: number }
  | { kind: 'revoked' };

interface Props {
  payload: SpaceInviteSystemPayload;
  senderName: string;
}

export function SpaceInviteCard({ payload, senderName }: Props) {
  const navigate = useNavigate();
  const joinByCode = useSpaceStore(s => s.joinByCode);
  const [live, setLive] = useState<LiveState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

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
          setLive({ kind: 'confirmed', memberCount: preview.memberCount });
        }
      },
      () => { if (!cancelled) setLive({ kind: 'revoked' }); },
    );
    return () => { cancelled = true; };
  }, [payload.inviteCode, payload.spaceId, payload.spaceInstanceOrigin]);

  const memberCount = live.kind === 'confirmed' ? live.memberCount : payload.snapshot.memberCount;
  const isRevoked = live.kind === 'revoked';

  const onJoin = async () => {
    if (joining || isRevoked) return;
    setJoining(true);
    setJoinError(null);
    try {
      // Three-way federation invariant: target the space's home origin, not
      // the DM transport origin nor window.location.origin. Empty string maps
      // to undefined so joinByCode follows its local-instance branch.
      const space = await joinByCode(payload.inviteCode, payload.spaceInstanceOrigin || undefined);
      navigate(`/channels/${space.id}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (msg.toLowerCase().includes('already a member')) {
        // Already a member is a successful state — just navigate to the space.
        // Look up the space in the store by id; if not found (rare race), stay
        // silent rather than block the user with a noisy error.
        navigate(`/channels/${payload.spaceId}`);
        return;
      }
      setJoinError(msg || 'Failed to join');
      setJoining(false);
    }
  };

  return (
    <div className={`my-1.5 max-w-md rounded-lg border border-white/[0.06] bg-surface-channel overflow-hidden ${isRevoked ? 'opacity-50' : ''}`}>
      <div className="px-3 py-1 text-[11px] text-txt-tertiary border-b border-white/[0.06]">
        {senderName} sent an invite
      </div>
      <div className="flex items-center gap-3 p-3">
        <Avatar
          src={payload.snapshot.icon}
          name={payload.snapshot.spaceName}
          size={48}
          avatarColor={payload.snapshot.avatarColor ?? undefined}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-txt-primary truncate">
            {payload.snapshot.spaceName}
          </div>
          <div className="text-[12px] text-txt-tertiary truncate">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
            {payload.snapshot.instanceName ? ` · ${payload.snapshot.instanceName}` : ''}
            {live.kind === 'loading' && (
              <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-txt-tertiary animate-pulse" />
            )}
          </div>
        </div>
        {isRevoked ? (
          <span className="glass-pill px-3 py-1 text-[12px] text-txt-tertiary">
            Invite no longer valid
          </span>
        ) : (
          <button
            onClick={onJoin}
            disabled={joining}
            className="px-4 py-1.5 rounded-md text-[13px] font-medium bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50"
          >
            {joining ? 'Joining…' : 'Join'}
          </button>
        )}
      </div>
      {joinError && (
        <div className="px-3 pb-2 text-[12px] text-txt-danger">{joinError}</div>
      )}
    </div>
  );
}
