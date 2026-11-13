import { useState, useRef, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { MemberWithUser } from '@backspace/shared';
import { useSpaceStore, getApiForOrigin, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { normalizeUserAssets } from '../../utils/assetUrls';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { Avatar } from '../ui/Avatar';
import { useDialogLayer } from '../../hooks/useDialogLayer';

function TransferMemberRow({
  member,
  origin,
  onSelect,
}: {
  member: MemberWithUser;
  /** The space's instance, which issued the member rows. */
  origin: string;
  onSelect: (userId: string) => void;
}) {
  const canonical = useCanonicalUserView(member.user, origin);
  const displayName = canonical.displayName || canonical.username;
  return (
    <button data-icon-motion="press"
      onClick={() => onSelect(member.userId)}
      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-wash/[0.06] transition-colors"
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={32}
        user={canonical}
        userId={member.userId}
      />
      <div className="flex flex-col items-start min-w-0">
        <span className="text-sm text-txt-primary truncate max-w-full">
          {displayName}
        </span>
        {canonical.displayName && (
          <span className="text-ui-caption text-txt-tertiary truncate max-w-full">
            {canonical.username}
          </span>
        )}
      </div>
    </button>
  );
}

export function TransferOwnershipModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { t } = useTranslation(['spaces', 'common']);
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const currentUserId = useAuthStore((s) => s.user?.id);
  const transferOwnership = useSpaceStore((s) => s.transferOwnership);
  const addToast = useUIStore((s) => s.addToast);

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [loading, setLoading] = useState(true);

  useDialogLayer(overlayRef, {
    open: !!space,
    onClose: () => selectedUserId ? setSelectedUserId(null) : onClose(),
    dismissible: !transferring,
    label: t('spaces:ownership.title'),
  });

  // Fetch members for the target space on mount (federation-aware)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const origin = (space as TaggedSpace)?._instanceOrigin ?? '';
        const client = getApiForOrigin(origin);
        const fetched = await client.spaces.members(spaceId);
        if (cancelled) return;
        for (const m of fetched) {
          if (origin) normalizeUserAssets(m.user, origin);
          useSpaceStore.getState().upsertUserView(m.user, origin);
        }
        setMembers(fetched);
      } catch {
        // Space may have been deleted or we lost access
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [spaceId, space]);

  // Filter members: exclude self, filter by search
  const filteredMembers = useMemo(() => {
    const spaceMembers = members.filter(m => m.userId !== currentUserId);
    if (!search.trim()) return spaceMembers;
    const q = search.toLowerCase();
    return spaceMembers.filter(m =>
      m.user.displayName?.toLowerCase().includes(q) ||
      m.user.username.toLowerCase().includes(q)
    );
  }, [members, currentUserId, search]);

  const selectedMember = selectedUserId ? members.find(m => m.userId === selectedUserId) : null;

  // Close on click outside. Escape is managed by the shared dialog layer.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        if (transferring) return;
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose, transferring]);

  if (!space) return null;

  const handleTransfer = async () => {
    if (!selectedUserId) return;
    setTransferring(true);
    try {
      await transferOwnership(spaceId, selectedUserId);
      addToast(t('spaces:ownership.success', { name: selectedMember?.user.displayName || selectedMember?.user.username }), 'success', 3000);
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : t('spaces:ownership.failed'), 'warning', 3000);
    } finally {
      setTransferring(false);
    }
  };

  return ReactDOM.createPortal(
    <div ref={overlayRef} className="fixed inset-0 z-confirm flex items-center justify-center bg-black/50">
      <div
        ref={modalRef}
        className="w-[380px] max-h-[480px] ui-dialog-surface flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-wash/[0.06]">
          <h3 className="text-base font-semibold text-txt-primary">{t('spaces:ownership.title')}</h3>
          <p className="text-xs text-txt-tertiary mt-0.5">
            <Trans
              t={t}
              i18nKey="spaces:ownership.description"
              values={{ name: space.name }}
              components={{ name: <span className="font-medium text-txt-secondary" /> }}
            />
          </p>
        </div>

        {selectedUserId && selectedMember ? (
          /* Confirm step */
          <div className="p-4 flex flex-col gap-4">
            <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20">
              <p className="text-sm text-txt-secondary">
                <Trans
                  t={t}
                  i18nKey="spaces:ownership.confirmQuestion"
                  values={{ space: space.name, member: selectedMember.user.displayName || selectedMember.user.username }}
                  components={{ name: <span className="font-semibold text-txt-primary" /> }}
                />
              </p>
              <p className="text-xs text-txt-tertiary mt-1.5">{t('spaces:ownership.regularMember')}</p>
            </div>
            <div className="flex gap-3">
              <button data-icon-motion="press"
                onClick={() => setSelectedUserId(null)}
                className="flex-1 py-2.5 text-sm font-medium text-txt-secondary bg-interactive-hover hover:bg-interactive-selected rounded-lg transition-colors disabled:opacity-50"
                disabled={transferring}
              >
                {t('common:actions.cancel')}
              </button>
              <button data-icon-motion="press"
                onClick={handleTransfer}
                disabled={transferring}
                className="ui-button ui-button-warning flex-1 transition-colors disabled:opacity-50"
              >
                {transferring ? t('spaces:ownership.transferring') : t('spaces:ownership.confirm')}
              </button>
            </div>
          </div>
        ) : (
          /* Member list */
          <>
            <div className="px-3 pt-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common:labels.searchMembers')}
                className="input-search w-full"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
              {loading ? (
                <p className="text-xs text-txt-tertiary text-center py-4">{t('spaces:ownership.loading')}</p>
              ) : filteredMembers.length === 0 ? (
                <p className="text-xs text-txt-tertiary text-center py-4">{t('common:labels.noMembersFound')}</p>
              ) : (
                filteredMembers.map((member) => (
                  <TransferMemberRow
                    key={member.userId}
                    member={member}
                    origin={(space as TaggedSpace)._instanceOrigin ?? ''}
                    onSelect={setSelectedUserId}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
