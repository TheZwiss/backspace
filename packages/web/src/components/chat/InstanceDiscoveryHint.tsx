import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { describeError } from '../../i18n/errors';

/**
 * What the hint has to say about this instance's own discovery settings, or
 * `none` when it has nothing to add. One derived value rather than a pile of
 * conditionals in the markup, and nothing is stored: turning space discovery
 * on moves the hint from `discoveryOffAdmin` to `notListed` because the
 * settings changed, not because the component remembers the click.
 *
 * The role is part of the row's name wherever it changes what renders, which
 * is every row that has an action: the member half of a pair is the same fact
 * with nothing to click.
 */
type DiscoveryHintRow =
  | 'none'
  | 'discoveryOffMember'
  | 'discoveryOffAdmin'
  | 'browseOffMember'
  | 'browseOffAdmin'
  | 'notListed';

/**
 * The row to render, first match wins.
 *
 * The two settings flags come from one document,
 * `settingsStore.streamingLimits`, which is null until it arrives and is the
 * only place `updateInstanceSettings` keeps current. A hint that took
 * `discoveryEnabled` from the explore store instead would be stating a fact
 * its own button cannot change: nothing writes that field but
 * `exploreStore.fetchSpaces`, so the row would sit on "space discovery is
 * off" until a refetch happened to land, and would stay there for the session
 * if that refetch failed.
 *
 * Unknown is not a fact either, so a null document renders nothing rather
 * than guessing a default. The failure that used to make this a real risk is
 * gone (`fetchStreamingLimits` leaves the field null when the request fails
 * rather than substituting defaults that assert `directoryEnabled: false`),
 * but the rule stands on its own: this surface offers writes, and it must
 * never offer one off a guessed value. The same rule governs the two nullable
 * directory facts below: each row that names one of them asks for `true` or
 * `false` explicitly and renders nothing while the answer is null.
 *
 * `directoryConfigured` is the operator's `DIRECTORY_ENDPOINT`, reported by
 * the public instance info and null until it arrives. Without one, listing is
 * a setting that does nothing: no pinger runs and no hub is ever told, and
 * browsing is a setting that does nothing either, because there is no hub to
 * browse. Both directory rows are therefore withheld unless the endpoint is
 * known to exist. Offering "List them" without one wrote the flag, took the
 * row away as though it had worked, and left the spaces exactly as unlisted
 * as before; naming the browse setting without one would name a switch that
 * changes nothing on an instance that has no directory at all.
 *
 * `directoryAvailable` is the endpoint and the admin's browse setting
 * together, from that same public document. It is the honest route to the
 * browse setting for a member: the setting itself lives on
 * `InstanceAdminSettings`, which only an admin may read, so a member surface
 * cannot ask for it directly. With `directoryConfigured` true, an available
 * flag of false can only be the admin's switch, and that is the pair the
 * browse rows are derived from.
 *
 * The browse rows sit above the listing row and below the discovery rows,
 * which is the ladder of the two axes in order: the discovery rows are about
 * this instance being found at all, and only then is there a question of what
 * it shows and what it lists.
 */
function discoveryHintRow(state: {
  limits: { discoveryEnabled: boolean; directoryEnabled: boolean } | null;
  directoryConfigured: boolean | null;
  directoryAvailable: boolean | null;
  isAdmin: boolean;
}): DiscoveryHintRow {
  if (state.limits === null) return 'none';
  if (!state.limits.discoveryEnabled) return state.isAdmin ? 'discoveryOffAdmin' : 'discoveryOffMember';
  if (state.directoryConfigured === true && state.directoryAvailable === false) {
    return state.isAdmin ? 'browseOffAdmin' : 'browseOffMember';
  }
  if (!state.limits.directoryEnabled && state.isAdmin && state.directoryConfigured === true) return 'notListed';
  return 'none';
}

/** Whether a row is a warning about this instance being unreachable, or a quiet statement of fact. */
function isWarningRow(row: DiscoveryHintRow): boolean {
  return row === 'discoveryOffAdmin' || row === 'discoveryOffMember';
}

interface InstanceDiscoveryHintProps {
  /**
   * Whether this instance has a `DIRECTORY_ENDPOINT`, from the same
   * `GET /api/instance/info` the page already reads; null until it arrives.
   */
  directoryConfigured: boolean | null;
  /**
   * Whether people here browse the directory, from that same document: the
   * endpoint and the admin's browse setting together. Null until it arrives.
   */
  directoryAvailable: boolean | null;
  /**
   * Called once space discovery has been turned on, so the page can refill
   * Inner Space without a reload. The hint does not fetch anything itself.
   */
  onDiscoveryEnabled: () => void;
  /**
   * Called once the browse setting has been turned on, so the page can re-read
   * the public instance info the `directoryAvailable` prop comes from. It is
   * awaited, so the button stays disabled until the row has moved, and it must
   * not reject: a re-read that fails is not the save's failure.
   */
  onBrowseEnabled: () => Promise<void>;
}

/**
 * Why Explore looks the way it does on this instance, and, for an admin, the
 * way to change it from here.
 *
 * Three facts on two axes. Space discovery off means no space on this
 * instance is in Explore for anyone, here or on an instance connected to it;
 * invite links still work. That is the outgoing axis at its lowest rung, and
 * the public directory listing is its highest: with it off, spaces here are
 * never listed globally. The incoming axis is separate and is what Outer
 * Space renders: with the browse setting off, spaces from other instances are
 * not shown here, whatever this instance sends out.
 *
 * For an admin the rows are those rungs in order, each offered in the same
 * place once the one above it has landed.
 */
export function InstanceDiscoveryHint({
  directoryConfigured,
  directoryAvailable,
  onDiscoveryEnabled,
  onBrowseEnabled,
}: InstanceDiscoveryHintProps) {
  const { t } = useTranslation(['spaces']);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const streamingLimits = useSettingsStore((s) => s.streamingLimits);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const [pending, setPending] = useState(false);
  // Kept with the row it was raised on. A message about a refused "List them"
  // must not end up under the discovery-off text because the rung moved while
  // it was on screen.
  const [failure, setFailure] = useState<{ row: DiscoveryHintRow; message: string } | null>(null);

  const row = discoveryHintRow({ limits: streamingLimits, directoryConfigured, directoryAvailable, isAdmin });
  const error = failure !== null && failure.row === row ? failure.message : '';

  // The row as of the last render, readable from a callback that started in an
  // earlier one. A click's `row` is captured when the handler is created, and
  // the settings can move under it while the request is in flight.
  const rowRef = useRef(row);
  rowRef.current = row;

  // Dropped, not merely hidden, once the row it belongs to is no longer the
  // one on screen. Keeping it would bring a message about an attempt made
  // minutes ago back under the original row if the rung were toggled off and
  // on again elsewhere.
  useEffect(() => {
    setFailure((current) => (current === null || current.row === row ? current : null));
  }, [row]);

  // The store keeps the old settings when the PATCH is rejected, so a failure
  // leaves the hint on the row it was already on and the message sits under
  // the text until the next attempt.
  const runAction = async (change: () => Promise<void>) => {
    const startedOn = row;
    setPending(true);
    setFailure(null);
    try {
      await change();
    } catch (err) {
      // The row this attempt was made on can be gone by the time the request
      // answers, moved by a WS ready or another tab. Recording the failure
      // then would store a message the effect above never sees (the row it
      // names is not the current one, and it does not change again on the way
      // in), leaving it to surface the next time that rung came back.
      if (rowRef.current !== startedOn) return;
      const message = err instanceof Error ? describeError(err) : t('spaces:explore.discoveryOff.failed');
      setFailure({ row: startedOn, message });
    } finally {
      setPending(false);
    }
  };

  const handleEnableDiscovery = () => runAction(async () => {
    await updateInstanceSettings({ discoveryEnabled: true });
    onDiscoveryEnabled();
  });

  const handleEnableBrowse = () => runAction(async () => {
    await updateInstanceSettings({ directoryBrowseEnabled: true });
    // This row names a fact of the public instance info, which the settings
    // document the PATCH answers with does not carry, so it moves only once
    // the page has re-read that info. Awaited so the button stays disabled
    // until it does, rather than re-enabling under a row about to go.
    await onBrowseEnabled();
  });

  const handleListSpaces = () => runAction(async () => {
    // Nothing to refetch: what this instance lists does not change what it sees.
    await updateInstanceSettings({ directoryEnabled: true });
  });

  if (row === 'none') return null;

  const text = row === 'discoveryOffAdmin'
    ? t('spaces:explore.discoveryOff.admin')
    : row === 'discoveryOffMember'
      ? t('spaces:explore.discoveryOff.member')
      : row === 'notListed'
        ? t('spaces:explore.notListed.text')
        // Both browse rows state the one fact; only the action differs.
        : t('spaces:explore.browseOff.text');

  const action = row === 'discoveryOffAdmin'
    ? { label: t('spaces:explore.discoveryOff.enable'), onClick: handleEnableDiscovery }
    : row === 'browseOffAdmin'
      ? { label: t('spaces:explore.browseOff.action'), onClick: handleEnableBrowse }
      : row === 'notListed'
        ? { label: t('spaces:explore.notListed.action'), onClick: handleListSpaces }
        : null;

  // One frame for every row, in one of two tones. Amber is for the instance
  // being unreachable except by invite link, which is a restriction worth
  // flagging; the two directory rows state a choice the instance made about
  // what it shows and what it lists, so they are quiet.
  const warning = isWarningRow(row);

  return (
    <div
      className={warning
        ? 'mb-4 p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber'
        : 'mb-4 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.04] text-[13px] text-txt-tertiary'}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-[14rem] flex-1">{text}</p>
        {action !== null && (
          <button
            type="button"
            onClick={action.onClick}
            disabled={pending}
            className={warning
              ? 'shrink-0 px-2.5 py-1 rounded bg-accent-amber/20 hover:bg-accent-amber/30 font-medium transition-colors disabled:opacity-50 disabled:cursor-default'
              : 'shrink-0 text-accent-primary hover:text-accent-primary/80 font-medium transition-colors disabled:text-txt-tertiary disabled:cursor-default'}
          >
            {action.label}
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-txt-danger">{error}</p>}
    </div>
  );
}
