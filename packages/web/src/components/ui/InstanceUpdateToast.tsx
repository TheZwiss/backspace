import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { shouldToastUpdate, pendingUpdateVersion } from '../../utils/updateAck';

/**
 * Tells an admin, once per release, that their instance has an update waiting.
 *
 * Renders nothing: it exists to raise a toast as a side effect, so it can be
 * mounted once high in the tree and cover both the desktop and mobile shells.
 *
 * "Once per release" is enforced by recording the version when the toast is
 * SHOWN, not when it is dismissed — `ToastContainer` cannot tell a dismissal
 * from its own timeout. That record is persisted, so remounting this component
 * (AppLayout is the element of two routes and remounts on an Explore
 * round-trip) does not raise it again.
 *
 * The copy names the instance explicitly. On desktop this toast can appear
 * alongside `UpdateToast`, which is about the desktop CLIENT updating itself,
 * and an admin should never have to guess which of the two is which.
 */
export function InstanceUpdateToast() {
  const { t } = useTranslation(['admin']);
  const status = useSettingsStore((s) => s.updateStatus);
  const ack = useSettingsStore((s) => s.updateAck);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const markUpdateToastShown = useSettingsStore((s) => s.markUpdateToastShown);

  useEffect(() => {
    // Guard on LIVE store state, not the `status`/`ack`/`isAdmin` closed over
    // from this render. React.StrictMode double-invokes mount effects on the
    // same render without a re-render in between, so both invocations would
    // otherwise see the identical (pre-toast) `ack` and both pass the guard.
    // Reading fresh here means the first invocation's synchronous
    // `markUpdateToastShown()` write is visible to the second.
    const { updateStatus: liveStatus, updateAck: liveAck, isAdmin: liveIsAdmin } = useSettingsStore.getState();
    if (!shouldToastUpdate(liveStatus, liveAck, liveIsAdmin)) return;
    const version = pendingUpdateVersion(liveStatus);
    if (version === null) return;

    const { addToast, openModal, pushMobileScreen } = useUIStore.getState();

    // Recorded before the toast is raised, so a re-render triggered by the
    // toast landing in the store cannot raise a second one.
    markUpdateToastShown();

    addToast(
      t('admin:updates.badge.toast', { version }),
      'info',
      0,
      {
        label: t('admin:updates.badge.toastAction'),
        onClick: () => {
          // Read `isMobile` fresh at click time rather than closing over it
          // above: the toast is sticky (duration 0) and can outlive a resize
          // across the mobile breakpoint, which mounts a different shell
          // (`MobileShell` vs. `UserSettingsModal`) than the one active when
          // the toast was created.
          if (useUIStore.getState().isMobile) {
            // The mobile Updates screen is reachable directly; the desktop modal
            // has no sub-tab deep link, so it opens on Instance and the dot on
            // the Updates sub-tab carries the last hop.
            pushMobileScreen('settings-instance-updates');
          } else {
            openModal('userSettings', { tab: 'instance' });
          }
        },
      },
    );
  }, [status, ack, isAdmin, markUpdateToastShown, t]);

  return null;
}
