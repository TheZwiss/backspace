import { useState, useRef, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';

export function TransferOwnershipModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const members = useSpaceStore((s) => s.members);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const transferOwnership = useSpaceStore((s) => s.transferOwnership);
  const addToast = useUIStore((s) => s.addToast);

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

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

  // Close on click-outside and escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedUserId) {
          setSelectedUserId(null);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, selectedUserId]);

  if (!space) return null;

  const handleTransfer = async () => {
    if (!selectedUserId) return;
    setTransferring(true);
    try {
      await transferOwnership(spaceId, selectedUserId);
      addToast(`Ownership transferred to ${selectedMember?.user.displayName || selectedMember?.user.username}`, 'success', 3000);
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to transfer ownership', 'warning', 3000);
    } finally {
      setTransferring(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50">
      <div
        ref={modalRef}
        className="w-[380px] max-h-[480px] glass-modal rounded-xl flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <h3 className="text-base font-semibold text-txt-primary">Transfer Ownership</h3>
          <p className="text-xs text-txt-tertiary mt-0.5">
            Choose a member to become the new owner of <span className="font-medium text-txt-secondary">{space.name}</span>
          </p>
        </div>

        {selectedUserId && selectedMember ? (
          /* Confirm step */
          <div className="p-4 flex flex-col gap-4">
            <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20">
              <p className="text-sm text-txt-secondary">
                Transfer ownership of <span className="font-semibold text-txt-primary">{space.name}</span> to{' '}
                <span className="font-semibold text-txt-primary">{selectedMember.user.displayName || selectedMember.user.username}</span>?
              </p>
              <p className="text-xs text-txt-tertiary mt-1.5">You will become a regular member.</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setSelectedUserId(null)}
                className="flex-1 py-2.5 text-sm font-medium text-txt-secondary bg-interactive-hover hover:bg-interactive-selected rounded-lg transition-colors disabled:opacity-50"
                disabled={transferring}
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={transferring}
                className="flex-1 py-2.5 bg-accent-amber hover:bg-accent-amber/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {transferring ? 'Transferring...' : 'Transfer'}
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
                placeholder="Search members..."
                className="input-search w-full"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
              {filteredMembers.length === 0 ? (
                <p className="text-xs text-txt-tertiary text-center py-4">No members found</p>
              ) : (
                filteredMembers.map((member) => {
                  return (
                    <button
                      key={member.userId}
                      onClick={() => setSelectedUserId(member.userId)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06] transition-colors"
                    >
                      <Avatar
                        src={member.user.avatar}
                        name={member.user.displayName || member.user.username}
                        size={32}
                        user={member.user}
                        userId={member.userId}
                      />
                      <div className="flex flex-col items-start min-w-0">
                        <span className="text-sm text-txt-primary truncate max-w-full">
                          {member.user.displayName || member.user.username}
                        </span>
                        {member.user.displayName && (
                          <span className="text-[11px] text-txt-tertiary truncate max-w-full">
                            {member.user.username}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
