import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import { useSocialStore } from '../stores/socialStore';
import { useUIStore } from '../stores/uiStore';
import { useFriendRequestNotices, type FriendRequestNotice } from '../utils/friendRequestNotification';
import { openDirectMessage } from '../utils/openDirectMessage';
import { describeError } from '../i18n/errors';
import { Avatar } from './ui/Avatar';
import { Tooltip } from './ui/Tooltip';
import { onNotificationClick } from '../platform/notifications';
import type { NativeFriendRequestAction } from '../platform/friendRequestBridge';
import { usePortalContainer } from '../hooks/usePortalContainer';

export function FriendRequestNotifications() {
  const { t } = useTranslation(['social', 'common']);
  const navigate = useNavigate();
  const notices = useFriendRequestNotices(s => s.notices);
  const remove = useFriendRequestNotices(s => s.remove);
  const requests = useSocialStore(s => s.requests);
  const ownerId = useAuthStore(s => s.user?.id);
  const container = usePortalContainer();
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const perform = useCallback(async (payload: NativeFriendRequestAction) => {
    if (payload.userId !== useAuthStore.getState().user?.id) return;
    if (payload.action === 'dismiss') { remove(`${payload.userId}:${payload.origin}:${payload.requestId}`); return; }
    const request = useSocialStore.getState().requests.flatMap(r => r._rows ?? [r]).find(r => r.id === payload.requestId && r._instanceOrigin === payload.origin);
    if (!request || request.status !== 'pending') return;
    const key = `${payload.userId}:${payload.origin}:${payload.requestId}`;
    if (pending.current.has(key)) return;
    pending.current.add(key); setBusy(new Set(pending.current));
    try {
      if (payload.action === 'open') {
        if (!request.user) return;
        const channelId = await openDirectMessage(request.user, payload.origin);
        if (payload.userId !== useAuthStore.getState().user?.id) return;
        useUIStore.getState().setShowDms(true);
        if (useUIStore.getState().isMobile) useUIStore.getState().pushMobileScreen('channel-chat', { channelId, spaceId: '@me' });
        navigate(`/channels/@me/${channelId}`);
      } else await useSocialStore.getState().updateFriendRequest(request.id, request._instanceOrigin, payload.action, request.user);
      remove(key);
    } catch (error) { useUIStore.getState().addToast(describeError(error), 'warning'); }
    finally { pending.current.delete(key); setBusy(new Set(pending.current)); }
  }, [navigate, remove]);
  useEffect(() => window.backspace?.onFriendRequestAction?.(action => { void perform(action); }), [perform]);
  useEffect(() => onNotificationClick(options => {
    if (options.kind === 'friend_request' && options.requestId && options.userId) void perform({ requestId: options.requestId, userId: options.userId, origin: options.origin ?? '', action: 'open' });
  }), [perform]);
  useEffect(() => {
    for (const notice of notices) {
      if (notice.ownerId !== ownerId || !requests.some(r => (r._rows ?? [r]).some(row => row.id === notice.request.id && row._instanceOrigin === notice.origin))) { remove(notice.key); window.backspace?.dismissFriendRequest?.({ requestId: notice.request.id, origin: notice.origin, userId: notice.ownerId }); }
    }
  }, [notices, requests, ownerId, remove]);
  useEffect(() => {
    const focus = () => { for (const notice of useFriendRequestNotices.getState().notices) window.backspace?.dismissFriendRequest?.({ requestId: notice.request.id, origin: notice.origin, userId: notice.ownerId }); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => () => {
    for (const notice of useFriendRequestNotices.getState().notices) if (notice.ownerId === ownerId) {
      remove(notice.key);
      window.backspace?.dismissFriendRequest?.({ requestId: notice.request.id, origin: notice.origin, userId: notice.ownerId });
    }
  }, [ownerId, remove]);
  const act = (notice: FriendRequestNotice, action: NativeFriendRequestAction['action']) => { void perform({ requestId: notice.request.id, origin: notice.origin, userId: notice.ownerId, action }); };
  return createPortal(<div className="fixed right-3 z-toast flex flex-col gap-2 pointer-events-none max-w-[calc(100*var(--app-vw)-24px)]" style={{ top: 'calc(var(--titlebar-inset, 0px) + var(--safe-top, 0px) + 12px)' }}>
    {notices.filter(n => n.ownerId === ownerId).map(notice => <article key={notice.key} className="flex items-center w-[356px] max-w-full gap-1 rounded-lg border border-border-soft border-l-2 border-l-accent-primary bg-surface-elevated p-2 shadow-elevation-high pointer-events-auto animate-slide-up" aria-label={t('social:friendNotification.title')} onClick={() => act(notice, 'open')} aria-busy={busy.has(notice.key)}>
      <button type="button" disabled={busy.has(notice.key)} onClick={event => { event.stopPropagation(); act(notice, 'open'); }} className="flex flex-1 min-w-0 items-center gap-2 rounded-md p-1 text-left hover:bg-interactive-hover" aria-label={t('social:friendNotification.open', { name: notice.request.user?.displayName || notice.request.user?.username })}>
        <Avatar src={notice.request.user?.avatar} name={notice.request.user?.displayName || notice.request.user?.username || '?'} size={36} user={notice.request.user} />
        <span className="min-w-0 flex-1"><strong className="block truncate text-ui-label font-semibold text-txt-primary">{notice.request.user?.displayName || notice.request.user?.username || t('social:friendNotification.title')}</strong><span role="status" className="block text-ui-caption text-txt-secondary leading-snug">{t('social:friendNotification.body')}</span></span>
      </button>
      <div className="flex items-center gap-1">
        <Tooltip content={t('common:actions.accept')}><button type="button" disabled={busy.has(notice.key)} aria-label={t('common:actions.accept')} onClick={event => { event.stopPropagation(); act(notice, 'accepted'); }} className="w-9 h-9 rounded-lg bg-accent-mint/10 text-accent-mint hover:bg-accent-mint/20 disabled:opacity-50"><svg className="mx-auto" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button></Tooltip>
        <Tooltip content={t('common:actions.decline')}><button type="button" disabled={busy.has(notice.key)} aria-label={t('common:actions.decline')} onClick={event => { event.stopPropagation(); act(notice, 'declined'); }} className="w-9 h-9 rounded-lg bg-accent-rose/10 text-accent-rose hover:bg-accent-rose/20 disabled:opacity-50"><svg className="mx-auto" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></Tooltip>
      </div>
      <button type="button" aria-label={t('common:actions.close')} onClick={event => { event.stopPropagation(); remove(notice.key); window.backspace?.dismissFriendRequest?.({ requestId: notice.request.id, origin: notice.origin, userId: notice.ownerId }); }} className="self-start flex h-6 w-6 items-center justify-center rounded text-txt-tertiary hover:text-txt-primary"><svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>
    </article>)}
  </div>, container);
}
