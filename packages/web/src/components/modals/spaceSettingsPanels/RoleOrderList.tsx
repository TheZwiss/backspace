import React, { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Role } from '@backspace/shared';
import { canManageRoleAt } from '@backspace/shared/src/permissions';
import { useSpaceStore, getApiForOrigin } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { describeError } from '../../../i18n/errors';
import { LOCK_ICON } from '../../ui/LockNote';
import { myStandingIn } from '../../../utils/roleHierarchy';
import { rolesInRankOrder, canReorderRoles, canMoveRole, moveRoleInRankOrder, roleMoveRequest } from '../../../utils/roleOrder';

// The role list of Space Settings > Roles, in rank order, with the controls
// that set the order (docs/systems/permissions.md, "Role hierarchy", "Setting
// the order"). On desktop the row of each role the viewer may move is what a
// drag picks up; its handle shows that and moves the role with the arrow keys.
// Every such role has up and down buttons, shown on hover or focus on desktop
// and always on a phone, so a move never needs a drag. A drag, a key and a
// button all go through `move`. Roles at or above the viewer's top role show
// a lock instead. @everyone stays at the bottom and never moves.
//
// A move shows at once, goes to the space's own instance, and is put back
// if it is refused, with the server's reason right under the role that moved
// back, where the user is looking.

type MoveControl = 'handle' | 'up' | 'down';

interface DropMarker {
  /** Index in rank order of the row the marker is drawn on. */
  index: number;
  edge: 'before' | 'after';
}

interface RoleOrderListProps {
  spaceId: string;
  /** Open the role's editor. */
  onOpen: (roleId: string) => void;
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60';

export function RoleOrderList({ spaceId, onOpen }: RoleOrderListProps) {
  const { t } = useTranslation('spaces');
  const roles = useSpaceStore((s) => s.roles);
  const members = useSpaceStore((s) => s.members);
  const space = useSpaceStore((s) => s.spaces.find((sp) => sp.id === spaceId));
  const setRoles = useSpaceStore((s) => s.setRoles);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const isMobile = useUIStore((s) => s.isMobile);

  const [moving, setMoving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropMarker, setDropMarker] = useState<DropMarker | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // The last refused move: shown under that role until the next move starts.
  const [moveError, setMoveError] = useState<{ roleId: string; message: string } | null>(null);
  const moveErrorRef = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ roleId: string; control: MoveControl } | null>(null);

  const ranked = rolesInRankOrder(roles, spaceId);
  const everyone = roles.find((r) => r.id === spaceId);
  const reorderable = !!space && canReorderRoles(ranked);
  // The viewer as a member of the space's own instance (their replicated
  // user there for a remote space); null when their row is not loaded, and
  // then the server decides.
  const viewer = space ? myStandingIn(space, members) : null;
  const canMove = (from: number, to: number) => reorderable && canMoveRole(viewer, ranked, from, to);
  const isLocked = (role: Role) => viewer !== null && !canManageRoleAt(viewer, role.position);

  // A move re-renders the rows in their new order; keep focus on the control
  // that moved the role, or on its other control once that one is disabled.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const order: MoveControl[] = [target.control, 'handle', target.control === 'up' ? 'down' : 'up'];
    for (const control of order) {
      const el = controls.current.get(`${target.roleId}:${control}`);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  }, [roles]);

  // A refused drag can put the role back in a row the list has scrolled away
  // from; bring the reason into view.
  useLayoutEffect(() => {
    moveErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [moveError]);

  const registerControl = (roleId: string, control: MoveControl) => (el: HTMLButtonElement | null) => {
    const key = `${roleId}:${control}`;
    if (el) controls.current.set(key, el);
    else controls.current.delete(key);
  };

  const move = async (from: number, to: number, control: MoveControl) => {
    if (moving || !space || !canMove(from, to)) return;
    const role = ranked[from];
    const request = roleMoveRequest(ranked, from, to);
    if (!role || !request) return;

    const before = roles;
    const optimistic = [...moveRoleInRankOrder(ranked, from, to), ...(everyone ? [everyone] : [])];
    pendingFocus.current = { roleId: role.id, control };
    setRoles(optimistic);
    setMoving(true);
    setMoveError(null);
    setAnnouncement(t('roles.reorder.moved', { name: role.name, position: to + 1, total: ranked.length }));

    try {
      // The server puts the role next to the role shown in the place it
      // moved to and renumbers the rest, which is the order already shown;
      // space_access_changed brings the space's refreshed detail to every
      // member, this list included.
      await getApiForOrigin(space._instanceOrigin ?? '').roles.update(spaceId, role.id, request);
    } catch (err) {
      // Put the order back unless something else has replaced the roles
      // since; then the space's own state is the one to show.
      if (useSpaceStore.getState().roles === optimistic) setRoles(before);
      else void loadSpaceDetail(spaceId, { quiet: true });
      setAnnouncement('');
      setMoveError({ roleId: role.id, message: describeError(err) });
    } finally {
      setMoving(false);
    }
  };

  const handleKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    void move(index, e.key === 'ArrowUp' ? index - 1 : index + 1, 'handle');
  };

  // The slot a drop over row `index` lands in, in rank order after the move.
  const dropTargetIndex = (index: number, edge: DropMarker['edge']): number => {
    if (dragIndex === null) return index;
    const insertAt = edge === 'before' ? index : index + 1;
    return insertAt > dragIndex ? insertAt - 1 : insertAt;
  };

  const handleDragOver = (index: number) => (e: React.DragEvent<HTMLDivElement>) => {
    if (dragIndex === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: DropMarker['edge'] = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const to = dropTargetIndex(index, edge);
    if (to === dragIndex || !canMove(dragIndex, to)) {
      setDropMarker(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropMarker?.index !== index || dropMarker.edge !== edge) setDropMarker({ index, edge });
  };

  const handleDrop = (index: number) => (e: React.DragEvent<HTMLDivElement>) => {
    if (dragIndex === null || !dropMarker || dropMarker.index !== index) return;
    e.preventDefault();
    const from = dragIndex;
    const to = dropTargetIndex(index, dropMarker.edge);
    setDragIndex(null);
    setDropMarker(null);
    void move(from, to, 'handle');
  };

  const endDrag = () => {
    setDragIndex(null);
    setDropMarker(null);
  };

  const lockIcon = (role: Role) => (
    <svg
      role="img"
      aria-label={t('roles.reorder.locked', { name: role.name })}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="text-txt-tertiary opacity-70 flex-shrink-0"
    >
      <title>{t('roles.reorder.locked', { name: role.name })}</title>
      <path d={LOCK_ICON} />
    </svg>
  );

  const renderRow = (role: Role, index: number | null) => {
    const isEveryone = index === null;
    const locked = !isEveryone && isLocked(role);
    const movable = !isEveryone && reorderable && !locked;
    const canUp = index !== null && canMove(index, index - 1);
    const canDown = index !== null && canMove(index, index + 1);
    const marker = index !== null && dropMarker?.index === index ? dropMarker.edge : null;
    const draggable = movable && !isMobile && index !== null;

    return (
      <div
        key={role.id}
        data-role-row=""
        draggable={draggable || undefined}
        onDragStart={draggable ? (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', role.id);
          // A drag that starts on the name or the handle (see below) still
          // shows the whole row under the pointer.
          const rect = e.currentTarget.getBoundingClientRect();
          e.dataTransfer.setDragImage?.(e.currentTarget, e.clientX - rect.left, e.clientY - rect.top);
          setDragIndex(index);
        } : undefined}
        onDragEnd={draggable ? endDrag : undefined}
        onClick={() => onOpen(role.id)}
        onDragOver={index !== null ? handleDragOver(index) : undefined}
        onDrop={index !== null ? handleDrop(index) : undefined}
        className={`relative flex items-center gap-1.5 rounded hover:bg-interactive-hover transition-colors cursor-pointer group/role ${
          reorderable && !isMobile ? 'pl-1 pr-2' : reorderable ? 'pl-3 pr-2' : 'px-3'
        } ${dragIndex !== null && dragIndex === index ? 'opacity-50' : ''}`}
      >
        {marker === 'before' && <div className="absolute -top-[2px] left-2 right-2 h-[2px] bg-accent-mint rounded-full z-10" />}

        {reorderable && !isMobile && (
          <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center">
            {movable && index !== null && (
              <button
                ref={registerControl(role.id, 'handle')}
                type="button"
                // Chrome starts no drag of the row from inside a button, so
                // the row's buttons that a drag may start on are draggable
                // themselves; their dragstart reaches the row's handler.
                draggable
                aria-label={t('roles.reorder.handle', { name: role.name })}
                title={t('roles.reorder.handleHint')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleKeyDown(index)}
                className={`w-6 h-6 flex items-center justify-center rounded text-txt-tertiary hover:text-txt-secondary cursor-grab active:cursor-grabbing transition-colors ${FOCUS_RING}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </button>
            )}
            {locked && lockIcon(role)}
          </div>
        )}

        <button
          type="button"
          draggable={draggable || undefined}
          className={`flex-1 min-w-0 flex items-center gap-2.5 py-2 rounded text-left ${FOCUS_RING}`}
        >
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: role.color }} />
          <span className="text-sm text-txt-primary truncate">
            {/* i18n-check: allow-literal — @everyone is the role's identifier, not a phrase */}
            {isEveryone ? '@everyone' : role.name}
          </span>
        </button>

        {reorderable && (
          <div
            className={`flex items-center flex-shrink-0 ${
              isMobile ? '' : 'opacity-0 group-hover/role:opacity-100 group-focus-within/role:opacity-100 transition-opacity'
            }`}
          >
            {movable && index !== null ? (
              <>
                <button
                  ref={registerControl(role.id, 'up')}
                  type="button"
                  aria-label={t('roles.reorder.up', { name: role.name })}
                  disabled={!canUp}
                  onClick={(e) => { e.stopPropagation(); void move(index, index - 1, 'up'); }}
                  className={`${isMobile ? 'w-10 h-10' : 'w-6 h-6'} flex items-center justify-center rounded text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-txt-tertiary disabled:cursor-default ${FOCUS_RING}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  ref={registerControl(role.id, 'down')}
                  type="button"
                  aria-label={t('roles.reorder.down', { name: role.name })}
                  disabled={!canDown}
                  onClick={(e) => { e.stopPropagation(); void move(index, index + 1, 'down'); }}
                  className={`${isMobile ? 'w-10 h-10' : 'w-6 h-6'} flex items-center justify-center rounded text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-txt-tertiary disabled:cursor-default ${FOCUS_RING}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </>
            ) : (
              <div className={`${isMobile ? 'w-20' : 'w-12'} flex items-center justify-center`}>
                {isMobile && locked && lockIcon(role)}
              </div>
            )}
          </div>
        )}

        <svg
          className="w-4 h-4 text-txt-tertiary group-hover/role:text-txt-secondary transition-colors flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        {marker === 'after' && <div className="absolute -bottom-[2px] left-2 right-2 h-[2px] bg-accent-mint rounded-full z-10" />}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-0.5" onDragEnd={endDrag}>
        {ranked.map((role, index) => (
          <React.Fragment key={role.id}>
            {renderRow(role, index)}
            {moveError?.roleId === role.id && (
              <div
                ref={moveErrorRef}
                role="alert"
                className="mx-2 mt-1 mb-1.5 px-2.5 py-1.5 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-[13px]"
              >
                {moveError.message}
              </div>
            )}
          </React.Fragment>
        ))}
        {everyone && renderRow(everyone, null)}
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
    </>
  );
}
