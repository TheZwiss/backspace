import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { type TaggedFriend } from '../../stores/socialStore';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { parseFederatedUsername } from '../../utils/identity';
import { describeError } from '../../i18n/errors';
import { sendSpaceInvite, type SpaceInviteSendStatus } from '../../utils/spaceInvite';
import type { User } from '@backspace/shared';

const FALLBACK_FRIEND = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as TaggedFriend;

/** One space can reach this client from several instances with coinciding ids. */
function spaceKey(space: TaggedSpace): string {
  return `${space.id}:${space._instanceOrigin}`;
}

function SpaceRow({
  space,
  status,
  disabled,
  onInvite,
}: {
  space: TaggedSpace;
  status: SpaceInviteSendStatus | undefined;
  disabled: boolean;
  onInvite: (space: TaggedSpace) => void;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  const sent = status?.kind === 'success';
  return (
    <button
      onClick={() => onInvite(space)}
      disabled={disabled || sent}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[4px] transition-colors text-left ${
        sent ? 'opacity-50 cursor-default' : 'hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed'
      }`}
    >
      <Avatar src={space.icon} name={space.name} size={30} userId={space.id} avatarColor={space.avatarColor} palette="space" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-txt-primary truncate">{space.name}</div>
        {status?.kind === 'failure' && (
          <div className="text-[11px] text-txt-danger truncate">{status.reason}</div>
        )}
      </div>
      {status?.kind === 'pending' && (
        <span className="text-[12px] text-txt-tertiary flex-shrink-0">...</span>
      )}
      {sent && (
        <span className="text-[12px] text-accent-mint flex-shrink-0">{t('spaces:invite.status.sent')}</span>
      )}
    </button>
  );
}

/**
 * Invite one friend to a space, reached from the friend's row (its context
 * menu). The mirror of InviteModal, which starts from the open space and picks
 * friends; both send the same card through `sendSpaceInvite`. The space's
 * invite code is generated lazily on click, so opening the list costs nothing,
 * and a space the user cannot create invites for only fails the row it is on.
 */
export function InviteFriendModal() {
  const { t } = useTranslation(['spaces', 'common']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const spaces = useSpaceStore((s) => s.spaces);
  const generateInvite = useSpaceStore((s) => s.generateInvite);

  const isOpen = activeModal === 'inviteFriend';
  const friend = (modalData.friend as TaggedFriend | undefined) ?? FALLBACK_FRIEND;

  const [results, setResults] = useState<Map<string, SpaceInviteSendStatus>>(new Map());

  useEffect(() => {
    if (isOpen) setResults(new Map());
  }, [isOpen, friend.id, friend._instanceOrigin]);

  const canonical = useCanonicalUserView(friend as unknown as User, friend._instanceOrigin);
  const friendName = canonical.displayName ?? parseFederatedUsername(canonical.username).baseName;

  const invite = async (space: TaggedSpace) => {
    const key = spaceKey(space);
    setResults((prev) => new Map(prev).set(key, { kind: 'pending' }));
    let status: SpaceInviteSendStatus;
    try {
      const inviteCode = await generateInvite(space.id);
      status = await sendSpaceInvite(
        friend,
        { spaceId: space.id, instanceOrigin: space._instanceOrigin ?? '', inviteCode },
        t,
      );
    } catch (err) {
      status = { kind: 'failure', reason: describeError(err) };
    }
    setResults((prev) => new Map(prev).set(key, status));
  };

  const sending = useMemo(
    () => [...results.values()].some((s) => s.kind === 'pending'),
    [results],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={t('spaces:inviteFriend.title', { name: friendName })}
      mobileStyle="sheet"
    >
      <div className="space-y-3">
        <p className="text-[13px] text-txt-tertiary">{t('spaces:inviteFriend.intro')}</p>

        <div className="max-h-[320px] overflow-y-auto space-y-[2px]">
          {spaces.length === 0 ? (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">
              {t('spaces:inviteFriend.noSpaces')}
            </div>
          ) : (
            spaces.map((space) => (
              <SpaceRow
                key={spaceKey(space)}
                space={space}
                status={results.get(spaceKey(space))}
                disabled={sending}
                onInvite={invite}
              />
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
