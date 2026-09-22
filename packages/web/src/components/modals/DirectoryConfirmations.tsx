import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../ui/ConfirmDialog';

/**
 * The two confirmations that stand in front of the instance-wide directory
 * switches.
 *
 * Both switches are one click that changes what this instance does to every
 * person on it, in a way nobody on the page asked for: listing publishes the
 * instance's address and the details of every space that opts in to a hub
 * anyone can read, and browsing sends every user's browser to instances this
 * administrator does not control. Neither is destructive and neither is
 * undoable from the outside, which is exactly the case a click with no
 * sentence attached gets wrong.
 *
 * They live here rather than in the surface that raises them because the
 * listing one is raised from two places, the Explore hint and the per-space
 * Discovery panel, and the decision is the same decision in both: one set of
 * words, translated once.
 *
 * The facts are one paragraph each, in the order a reader needs them: what
 * the switch does, what it does not do, and where it is undone. The first
 * paragraph of each is the sentence the admin settings panel already states
 * about the same switch, read from the `admin` catalog rather than copied
 * into this one, so the two surfaces cannot drift apart in four languages.
 */
interface DirectoryConfirmProps {
  isOpen: boolean;
  /** Dismiss without writing anything. */
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  /** The write is in flight: both buttons are inert until it answers. */
  loading: boolean;
}

interface ListInDirectoryConfirmProps extends DirectoryConfirmProps {
  /**
   * One sentence placed before the shared paragraphs, for a caller whose
   * write is not exactly the one the Explore hint makes. The per-space panel
   * writes the whole global rung rather than the listing flag alone, so it
   * says so here; everything after it is the same decision in the same
   * words.
   */
  intro?: string;
}

/** The paragraphs of a confirmation, stacked. */
function Facts({ facts }: { facts: readonly string[] }) {
  return (
    <div className="space-y-2">
      {facts.map((fact) => <p key={fact}>{fact}</p>)}
    </div>
  );
}

/**
 * Before `directoryEnabled: true`: this instance starts telling the hub about
 * itself and about every space whose owner has opted in.
 */
export function ListInDirectoryConfirm({ isOpen, onClose, onConfirm, loading, intro }: ListInDirectoryConfirmProps) {
  const { t } = useTranslation(['spaces', 'admin']);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('spaces:explore.notListed.confirm.title')}
      description={<Facts facts={[
        ...(intro === undefined ? [] : [intro]),
        t('admin:general.directory.disclosure'),
        t('spaces:explore.notListed.confirm.optIn'),
        t('spaces:explore.notListed.confirm.off'),
      ]} />}
      confirmLabel={t('spaces:explore.notListed.confirm.action')}
      variant="warning"
      loading={loading}
    />
  );
}

/**
 * Before `directoryBrowseEnabled: true`: Outer Space appears, and with it the
 * requests every viewer's browser then makes to the instances that own those
 * spaces.
 */
export function ShowGlobalSpacesConfirm({ isOpen, onClose, onConfirm, loading }: DirectoryConfirmProps) {
  const { t } = useTranslation(['spaces', 'admin']);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('spaces:explore.browseOff.confirm.title')}
      description={<Facts facts={[
        t('admin:general.browse.toggleDescription'),
        t('spaces:explore.browseOff.confirm.exposure'),
        t('spaces:explore.browseOff.confirm.off'),
      ]} />}
      confirmLabel={t('spaces:explore.browseOff.confirm.action')}
      variant="warning"
      loading={loading}
    />
  );
}
