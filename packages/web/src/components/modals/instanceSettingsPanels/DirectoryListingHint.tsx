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
 * would drop an unsaved draft. The note first appears when the admin has
 * just picked the rung and not saved it yet, so rather than hide the button
 * then, the panel passes its save as `saveFirst` while it has unsaved
 * changes: the button reads "Save and show me where", saves, and leaves only
 * if the save succeeded (a failure stays on the panel, where its error line
 * shows). The button is absent only when the admin manages no space here:
 * the sentence still says what a space owner has to do.
 */
export function DirectoryListingHint({ saveFirst, saving }: {
  /** The panel's save while it has unsaved changes, null when it has none. */
  saveFirst: (() => Promise<boolean>) | null;
  /** A save is in flight, from this button or the save bar. */
  saving: boolean;
}) {
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

  const showMeWhere = async () => {
    if (!target) return;
    if (saveFirst !== null && !(await saveFirst())) return;
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
      {target !== null && (
        <button
          type="button"
          onClick={() => { void showMeWhere(); }}
          disabled={saving}
          className="px-2.5 py-1 rounded bg-accent-amber/20 hover:bg-accent-amber/30 text-[13px] font-medium transition-colors disabled:opacity-50"
        >
          {saveFirst !== null ? t('admin:general.directory.saveAndShowMeWhere') : t('admin:general.directory.showMeWhere')}
        </button>
      )}
    </div>
  );
}
