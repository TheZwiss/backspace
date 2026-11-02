import { Button } from '../ui/Button';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { User } from '@backspace/shared';
import { useSocialStore } from '../../stores/socialStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { selfIdentityOf } from '../../utils/identity';
import { getFriendshipStatus } from '../../utils/friendshipStatus';
import { friendRequestTarget } from '../../utils/friendRequestTarget';
import { describeError } from '../../i18n/errors';

export function DmFriendshipBanner({ user, origin }: { user: User; origin: string }) {
  const { t } = useTranslation(['dm', 'social', 'common']);
  const friends = useSocialStore(s => s.friends);
  const requests = useSocialStore(s => s.requests);
  const self = useAuthStore(s => s.user);
  const myRowIds = useAuthStore(s => s.myRowIds);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const social = useSocialStore.getState();
    void social.loadFriends(); void social.loadRequests();
  }, [user.id, origin]);
  const status = getFriendshipStatus({ viewedUser: user, origin, self: selfIdentityOf(self, myRowIds), friends, requests });
  if (status.state === 'self' || status.state === 'friends' || user.isDeleted) return null;
  const run = async (accept = true) => {
    if (busy) return;
    setBusy(true);
    try {
      const social = useSocialStore.getState();
      if (status.state === 'inbound_pending') await social.updateFriendRequest(status.request.id, status.request._instanceOrigin, accept ? 'accepted' : 'declined', status.request.user ?? undefined);
      else if (status.state === 'outbound_pending') await social.cancelFriendRequest(status.request.id, status.request._instanceOrigin, status.request.user ?? undefined);
      else await social.sendFriendRequest(friendRequestTarget(user, origin));
    } catch (error) { useUIStore.getState().addToast(describeError(error), 'warning'); }
    finally { setBusy(false); }
  };
  const outgoing = status.state === 'outbound_pending';
  return <div className="shrink-0 ui-notice px-4 py-3" role="region" aria-label={t('dm:friendship.title')} aria-busy={busy}>
    <div className="flex flex-col gap-3 desktop:flex-row desktop:items-center desktop:justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent-primary/20 bg-accent-primary/10 text-accent-primary">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20v-2a6 6 0 0 1 12 0v2M19 8v6m-3-3h6" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-ui-label font-semibold text-txt-primary">{t('dm:friendship.title')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-txt-secondary">{t(status.state === 'inbound_pending' ? 'dm:friendship.incoming' : outgoing ? 'dm:friendship.outgoing' : 'dm:friendship.none')}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 desktop:pl-3">
        <Button data-icon-motion="press" variant={outgoing ? 'secondary' : 'primary'} disabled={busy} onClick={() => void run()} className="min-h-11 flex-1 desktop:flex-none whitespace-nowrap">
          {busy ? <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" /><path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg> : !outgoing && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={status.state === 'inbound_pending' ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'} /></svg>}
          {t(status.state === 'inbound_pending' ? 'common:actions.accept' : outgoing ? 'social:request.cancel' : 'social:profile.addFriend')}
        </Button>
        {status.state === 'inbound_pending' && <Button data-icon-motion="press" variant="secondary" disabled={busy} onClick={() => void run(false)} className="min-h-11">{t('common:actions.decline')}</Button>}
      </div>
    </div>
  </div>;
}
