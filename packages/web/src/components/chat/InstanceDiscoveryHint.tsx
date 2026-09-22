import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { describeError } from '../../i18n/errors';

/**
 * What the hint has to say about this instance's own discovery settings, or
 * `none` when it has nothing to add. One derived value rather than a pile of
 * conditionals in the markup, and nothing is stored: turning space discovery
 * on moves the hint from `discoveryOffAdmin` to `notListed` because the
 * settings changed, not because the component remembers the click.
 */
type DiscoveryHintRow = 'none' | 'discoveryOffMember' | 'discoveryOffAdmin' | 'notListed';

/**
 * The row to render, first match wins.
 *
 * Both flags come from one document, `settingsStore.streamingLimits`, which
 * is null until it arrives and is the only place `updateInstanceSettings`
 * keeps current. A hint that took `discoveryEnabled` from the explore store
 * instead would be stating a fact its own button cannot change: nothing
 * writes that field but `exploreStore.fetchSpaces`, so the row would sit on
 * "space discovery is off" until a refetch happened to land, and would stay
 * there for the session if that refetch failed.
 *
 * Unknown is not a fact either, so a null document renders nothing rather
 * than guessing a default. The failure that used to make this a real risk is
 * gone (`fetchStreamingLimits` leaves the field null when the request fails
 * rather than substituting defaults that assert `directoryEnabled: false`),
 * but the rule stands on its own: this surface offers writes, and it must
 * never offer one off a guessed value.
 */
function discoveryHintRow(state: {
  limits: { discoveryEnabled: boolean; directoryEnabled: boolean } | null;
  isAdmin: boolean;
}): DiscoveryHintRow {
  if (state.limits === null) return 'none';
  if (!state.limits.discoveryEnabled) return state.isAdmin ? 'discoveryOffAdmin' : 'discoveryOffMember';
  if (!state.limits.directoryEnabled && state.isAdmin) return 'notListed';
  return 'none';
}

interface InstanceDiscoveryHintProps {
  /**
   * Called once space discovery has been turned on, so the page can refill
   * Inner Space without a reload. The hint does not fetch anything itself.
   */
  onDiscoveryEnabled: () => void;
}

/**
 * Why Explore looks the way it does on this instance, and, for an admin, the
 * way to change it from here.
 *
 * Two facts, one rung of the ladder apart. Space discovery off means no space
 * on this instance is in Explore for anyone, here or on an instance connected
 * to it; invite links still work. The public directory listing off means
 * spaces here are never listed globally, which has nothing to do with what
 * Outer Space shows: browsing the directory only needs the instance's
 * `DIRECTORY_ENDPOINT`.
 *
 * For an admin the two rows are the ladder in order: the first click gets the
 * instance into Explore, and the second, offered in the same place once the
 * first has landed, lists it globally.
 */
export function InstanceDiscoveryHint({ onDiscoveryEnabled }: InstanceDiscoveryHintProps) {
  const { t } = useTranslation(['spaces']);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const streamingLimits = useSettingsStore((s) => s.streamingLimits);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const [pending, setPending] = useState(false);
  // Kept with the row it was raised on. A message about a refused "List them"
  // must not end up under the discovery-off text because an admin changed the
  // rung in Instance -> General while it was on screen.
  const [failure, setFailure] = useState<{ row: DiscoveryHintRow; message: string } | null>(null);

  const row = discoveryHintRow({ limits: streamingLimits, isAdmin });
  const error = failure !== null && failure.row === row ? failure.message : '';

  // The store keeps the old settings when the PATCH is rejected, so a failure
  // leaves the hint on the row it was already on and the message sits under
  // the text until the next attempt.
  const runAction = async (change: () => Promise<void>) => {
    setPending(true);
    setFailure(null);
    try {
      await change();
    } catch (err) {
      const message = err instanceof Error ? describeError(err) : t('spaces:explore.discoveryOff.failed');
      setFailure({ row, message });
    } finally {
      setPending(false);
    }
  };

  const handleEnableDiscovery = () => runAction(async () => {
    await updateInstanceSettings({ discoveryEnabled: true });
    onDiscoveryEnabled();
  });

  const handleListSpaces = () => runAction(async () => {
    // Nothing to refetch: what this instance lists does not change what it sees.
    await updateInstanceSettings({ directoryEnabled: true });
  });

  if (row === 'none') return null;

  if (row === 'notListed') {
    return (
      <div className="mb-4 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.04] text-[13px] text-txt-tertiary">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="min-w-[14rem] flex-1">{t('spaces:explore.notListed.text')}</p>
          <button
            type="button"
            onClick={handleListSpaces}
            disabled={pending}
            className="shrink-0 text-accent-primary hover:text-accent-primary/80 font-medium transition-colors disabled:text-txt-tertiary disabled:cursor-default"
          >
            {t('spaces:explore.notListed.action')}
          </button>
        </div>
        {error && <p className="mt-1.5 text-txt-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mb-4 p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-[14rem] flex-1">
          {row === 'discoveryOffAdmin'
            ? t('spaces:explore.discoveryOff.admin')
            : t('spaces:explore.discoveryOff.member')}
        </p>
        {row === 'discoveryOffAdmin' && (
          <button
            type="button"
            onClick={handleEnableDiscovery}
            disabled={pending}
            className="shrink-0 px-2.5 py-1 rounded bg-accent-amber/20 hover:bg-accent-amber/30 font-medium transition-colors disabled:opacity-50 disabled:cursor-default"
          >
            {t('spaces:explore.discoveryOff.enable')}
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-txt-danger">{error}</p>}
    </div>
  );
}
