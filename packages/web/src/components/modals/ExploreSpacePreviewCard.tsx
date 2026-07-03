import { useSpaceJoin } from '../../hooks/useSpaceJoin';
import { getSpaceGradient } from '../../utils/gradients';
import type { TaggedExploreSpace } from '../../stores/exploreStore';

export function ExploreSpacePreviewCard({
  space,
  onJoinSuccess,
}: {
  space: TaggedExploreSpace;
  onJoinSuccess: (spaceId: string) => void;
}) {
  const {
    isPublic,
    isPending,
    joining,
    joinError,
    showRequestForm,
    requestMessage,
    setRequestMessage,
    openRequestForm,
    cancelRequestForm,
    join,
    sendRequest,
  } = useSpaceJoin(space);

  const fallbackGradient = getSpaceGradient(space.id, space.name, space.avatarColor).gradient;
  const iconUrl = space.icon
    ? (space.icon.startsWith('http') || space.icon.startsWith('/') ? space.icon : `/api/uploads/${space.icon}`)
    : null;
  const originLabel = space._instanceOrigin
    ? (() => { try { return new URL(space._instanceOrigin).host; } catch { return space._instanceOrigin; } })()
    : null;

  const handleJoin = async () => {
    const full = await join();
    if (full) onJoinSuccess(full.id);
  };

  return (
    <div className="rounded-lg bg-surface-channel border border-border-soft hover:border-border-hard transition-colors px-3 py-2.5">
      <div className="flex items-center gap-3">
        {/* Icon */}
        {iconUrl ? (
          <img src={iconUrl} alt={space.name} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
        ) : (
          <div
            className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center text-sm font-bold text-white/90"
            style={{ background: fallbackGradient }}
          >
            {space.name.charAt(0).toUpperCase()}
          </div>
        )}

        {/* Name + meta */}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-txt-primary truncate">{space.name}</div>
          <div className="flex items-center gap-2 text-[12px] text-txt-tertiary">
            <span>{space.memberCount} {space.memberCount === 1 ? 'member' : 'members'}</span>
            {originLabel && <span className="truncate text-txt-tertiary/70">· {originLabel}</span>}
          </div>
        </div>

        {/* Action */}
        <div className="flex-shrink-0">
          {isPublic ? (
            <button
              type="button"
              onClick={handleJoin}
              disabled={joining}
              className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary-hover text-white text-xs font-medium rounded-full transition-colors disabled:opacity-50"
            >
              {joining ? 'Joining…' : 'Join'}
            </button>
          ) : isPending ? (
            <span className="px-3 py-1.5 text-xs font-medium text-txt-tertiary">Pending</span>
          ) : (
            <button
              type="button"
              onClick={openRequestForm}
              className="px-3 py-1.5 bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber text-xs font-medium rounded-full transition-colors"
            >
              Request
            </button>
          )}
        </div>
      </div>

      {/* Inline request form */}
      {showRequestForm && (
        <div className="mt-2.5 space-y-2">
          <textarea
            value={requestMessage}
            onChange={(e) => setRequestMessage(e.target.value.slice(0, 200))}
            placeholder="Why do you want to join? (optional)"
            rows={2}
            className="input-standard w-full resize-none text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={sendRequest}
              disabled={joining}
              className="flex-1 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-[#13131a] text-xs font-medium rounded transition-colors disabled:opacity-50"
            >
              {joining ? 'Sending…' : 'Send Request'}
            </button>
            <button
              type="button"
              onClick={cancelRequestForm}
              className="px-3 py-1.5 text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {joinError && <div className="mt-2 text-[12px] text-txt-danger">{joinError}</div>}
    </div>
  );
}
