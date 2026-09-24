import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useSpaceStore } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { resolveSpaceLayout, spacesInLayoutOrder } from '../../../utils/spaceLayout';
import { spaceToShowForListing } from '../../../utils/directory';

/**
 * The note under the global rung while no space here is listed: the rung
 * allows listing and lists nothing itself, so an admin who picks it and
 * then finds the directory empty is told where the other half lives.
 *
 * "Show me where" leaves the settings for a space's Discovery tab, which
 * would drop an unsaved draft, so the panel passes `canLeave` only while it
 * has none. The button is also absent when the admin manages no space here:
 * the sentence still says what a space owner has to do.
 */
export function DirectoryListingHint({ canLeave }: { canLeave: boolean }) {
  const { t } = useTranslation(['admin', 'spaces']);
  const navigate = useNavigate();
  const spaces = useSpaceStore((s) => s.spaces);
  const spaceLayout = useSpaceStore((s) => s.spaceLayout);
  const folders = useSpaceStore((s) => s.folders);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);

  const target = useMemo(
    () => spaceToShowForListing(spacesInLayoutOrder(resolveSpaceLayout(spaces, spaceLayout, folders)), spacePermissions),
    [spaces, spaceLayout, folders, spacePermissions],
  );

  const showMeWhere = () => {
    if (!target) return;
    const ui = useUIStore.getState();
    // The same steps as picking the space in the rail, so closing the space
    // settings leaves the admin in that space rather than where they were.
    if (ui.isMobile) ui.setMobileTab('spaces');
    ui.setShowDms(false);
    setCurrentSpace(target.id);
    navigate(`/channels/${target.id}`);
    // Replaces the settings modal this panel is in.
    ui.openModal('spaceSettings', { tab: 'discovery' });
  };

  return (
    <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber space-y-2">
      <p>{t('admin:general.directory.listingHint', { setting: t('spaces:settings.discovery.directory.label') })}</p>
      {target !== null && canLeave && (
        <button
          type="button"
          onClick={showMeWhere}
          className="px-2.5 py-1 rounded bg-accent-amber/20 hover:bg-accent-amber/30 text-[13px] font-medium transition-colors"
        >
          {t('admin:general.directory.showMeWhere')}
        </button>
      )}
    </div>
  );
}
