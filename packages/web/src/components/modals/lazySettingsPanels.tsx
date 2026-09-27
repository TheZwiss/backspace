import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';

// The settings panels (user, instance administration and space settings) are
// loaded on demand: none of them is needed to draw the first screen, and
// together they are a large part of what would otherwise be the main chunk,
// which has to stay under the service worker's precache limit (see
// `src/build/precache.ts`). Each import below becomes its own chunk. The
// chunks are still precached, so an installed app opens them offline.
//
// Every surface that shows a panel imports it from here, the desktop modals
// and the mobile screens alike. A static import of a panel anywhere else in
// the main chunk's import graph would pull it back into that chunk.

export const AccountPanel = lazy(() =>
  import('./settingsPanels/AccountPanel').then((m) => ({ default: m.AccountPanel })));
export const AppearancePanel = lazy(() =>
  import('./settingsPanels/AppearancePanel').then((m) => ({ default: m.AppearancePanel })));
export const VoicePanel = lazy(() =>
  import('./settingsPanels/VoicePanel').then((m) => ({ default: m.VoicePanel })));
export const PrivacyPanel = lazy(() =>
  import('./settingsPanels/PrivacyPanel').then((m) => ({ default: m.PrivacyPanel })));
export const ConnectionsPanel = lazy(() =>
  import('./settingsPanels/ConnectionsPanel').then((m) => ({ default: m.ConnectionsPanel })));
export const KeybindsPanel = lazy(() =>
  import('./settingsPanels/KeybindsPanel').then((m) => ({ default: m.KeybindsPanel })));
export const DesktopPanel = lazy(() =>
  import('./settingsPanels/DesktopPanel').then((m) => ({ default: m.DesktopPanel })));
export const DesktopDownloadPanel = lazy(() =>
  import('./settingsPanels/DesktopDownloadPanel').then((m) => ({ default: m.DesktopDownloadPanel })));
export const InstancePanel = lazy(() =>
  import('./settingsPanels/InstancePanel').then((m) => ({ default: m.InstancePanel })));

export const GeneralPanel = lazy(() =>
  import('./instanceSettingsPanels/GeneralPanel').then((m) => ({ default: m.GeneralPanel })));
export const RegistrationPanel = lazy(() =>
  import('./instanceSettingsPanels/RegistrationPanel').then((m) => ({ default: m.RegistrationPanel })));
export const FederationPanel = lazy(() =>
  import('./instanceSettingsPanels/FederationPanel').then((m) => ({ default: m.FederationPanel })));
export const StreamingPanel = lazy(() =>
  import('./instanceSettingsPanels/StreamingPanel').then((m) => ({ default: m.StreamingPanel })));
export const StoragePanel = lazy(() =>
  import('./instanceSettingsPanels/StoragePanel').then((m) => ({ default: m.StoragePanel })));
export const UsersPanel = lazy(() =>
  import('./instanceSettingsPanels/UsersPanel').then((m) => ({ default: m.UsersPanel })));
export const UpdatesPanel = lazy(() =>
  import('./instanceSettingsPanels/UpdatesPanel').then((m) => ({ default: m.UpdatesPanel })));
export const TelemetryPanel = lazy(() =>
  import('./instanceSettingsPanels/TelemetryPanel').then((m) => ({ default: m.TelemetryPanel })));

export const OverviewPanel = lazy(() =>
  import('./spaceSettingsPanels/OverviewPanel').then((m) => ({ default: m.OverviewPanel })));
export const MembersPanel = lazy(() =>
  import('./spaceSettingsPanels/MembersPanel').then((m) => ({ default: m.MembersPanel })));
export const RolesPanel = lazy(() =>
  import('./spaceSettingsPanels/RolesPanel').then((m) => ({ default: m.RolesPanel })));
export const BansPanel = lazy(() =>
  import('./spaceSettingsPanels/BansPanel').then((m) => ({ default: m.BansPanel })));

/**
 * Holds the panel's place while its chunk loads. The block has a fixed height
 * whether or not the spinner shows, and the spinner only appears after the
 * usual loading delay, so a chunk served from the service worker's cache
 * swaps in without a flash.
 */
function SettingsPanelFallback() {
  const { t } = useTranslation('common');
  const showSpinner = useDelayedLoading(true);
  return (
    <div className="flex items-center justify-center h-64 text-txt-tertiary" role="status" aria-label={t('states.loading')}>
      {showSpinner && <LoadingSpinner size={28} />}
    </div>
  );
}

/** The boundary every lazily loaded settings panel renders inside. */
export function SettingsPanelSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<SettingsPanelFallback />}>{children}</Suspense>;
}
