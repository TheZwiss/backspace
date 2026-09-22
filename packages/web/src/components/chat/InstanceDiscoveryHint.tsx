import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { describeError } from '../../i18n/errors';
import { ListInDirectoryConfirm, ShowGlobalSpacesConfirm } from '../modals/DirectoryConfirmations';

/**
 * One thing the hint has to say about this instance's own settings.
 *
 * Nothing is stored: turning space discovery on drops `discoveryOffAdmin`
 * from the set because the settings changed, not because the component
 * remembers the click.
 *
 * The role is part of a row's name wherever it changes what renders, which is
 * every row that has an action: the member half of a pair is the same fact
 * with nothing to click.
 */
type DiscoveryHintRow =
  | 'discoveryOffMember'
  | 'discoveryOffAdmin'
  | 'notListed'
  | 'browseOffMember'
  | 'browseOffAdmin';

/**
 * Every row that applies, in a fixed order. Not the first match: these are
 * three separate facts about two independent settings, and a surface that
 * showed one of them made the page illegible. An instance with discovery off
 * and browsing off used to say one thing, and only once that was fixed did it
 * admit to the other, so an admin walked a ladder the settings do not
 * actually form. The order is the page's own sense, outgoing before incoming:
 * whether this instance can be found at all, then whether it is listed
 * globally, then what it shows of everyone else.
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
 * Unknown is not a fact either, so a null document says nothing at all rather
 * than guessing a default. The failure that used to make this a real risk is
 * gone (`fetchStreamingLimits` leaves the field null when the request fails
 * rather than substituting defaults that assert `directoryEnabled: false`),
 * but the rule stands on its own: this surface offers writes, and it must
 * never offer one off a guessed value. The same rule governs the two nullable
 * directory facts below: each row that names one of them asks for `true` or
 * `false` explicitly and is left out while the answer is null.
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
 * The listing row does not ask whether discovery is on. It used to, by
 * accident of being checked after the discovery row returned, and the
 * accident hid the fact rather than stating it: an instance that is both
 * invite-only and unlisted is both of those things, and saying only the first
 * is what this function stopped doing. The action that row offers writes the
 * whole global rung, so the pair the server refuses is never sent.
 */
function discoveryHintRows(state: {
  limits: { discoveryEnabled: boolean; directoryEnabled: boolean } | null;
  directoryConfigured: boolean | null;
  directoryAvailable: boolean | null;
  isAdmin: boolean;
}): DiscoveryHintRow[] {
  if (state.limits === null) return [];
  const rows: DiscoveryHintRow[] = [];

  if (!state.limits.discoveryEnabled) {
    rows.push(state.isAdmin ? 'discoveryOffAdmin' : 'discoveryOffMember');
  }
  // Only an admin is told about the listing: a member cannot change it, and
  // "the spaces you can see are not listed somewhere you are not looking" is
  // not a fact a member needs on the page they came to browse.
  if (!state.limits.directoryEnabled && state.isAdmin && state.directoryConfigured === true) {
    rows.push('notListed');
  }
  if (state.directoryConfigured === true && state.directoryAvailable === false) {
    rows.push(state.isAdmin ? 'browseOffAdmin' : 'browseOffMember');
  }

  return rows;
}

/**
 * Whether a row is a warning about this instance being unreachable, or a
 * quiet statement of fact. Amber is for the instance being reachable only by
 * invite link, which is a restriction worth flagging; the two directory rows
 * state a choice the instance made about what it lists and what it shows.
 */
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
 * Three facts on two axes, all of them stated when all of them apply. Space
 * discovery off means no space on this instance is in Explore for anyone,
 * here or on an instance connected to it; invite links still work. That is
 * the outgoing axis at its lowest rung, and the public directory listing is
 * its highest: with it off, spaces here are never listed globally. The
 * incoming axis is separate and is what Outer Space renders: with the browse
 * setting off, spaces from other instances are not shown here, whatever this
 * instance sends out.
 *
 * One strip, one material, one line per fact. Two or three of these sit above
 * the spaces the page is actually for, so none of them is a card and none of
 * them is filled: the warning row carries its tone in the text, and every
 * action is the same quiet link.
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

  const [pending, setPending] = useState<DiscoveryHintRow | null>(null);
  // Kept with the row it was raised on. A message about a refused "List them"
  // must not end up under the discovery-off text because the settings moved
  // while it was on screen, and with the rows stacked it must not end up
  // under the neighbour either.
  const [failure, setFailure] = useState<{ row: DiscoveryHintRow; message: string } | null>(null);
  /**
   * The row whose action is waiting to be confirmed, or null when nothing is
   * being asked.
   *
   * Ordinary component state, and not the kind the derivation forbids: it
   * says whether a dialog is on screen, never what the instance's settings
   * are. It is held as the row it was raised on rather than as a boolean for
   * the same reason `failure` is: the settings can move under an open dialog,
   * from another tab or a WS ready, and a dialog asking about a row that is
   * no longer on the page must go with it rather than stay and write
   * something the admin is no longer looking at.
   */
  const [confirming, setConfirming] = useState<DiscoveryHintRow | null>(null);

  const rows = useMemo(
    () => discoveryHintRows({ limits: streamingLimits, directoryConfigured, directoryAvailable, isAdmin }),
    [streamingLimits, directoryConfigured, directoryAvailable, isAdmin],
  );
  // The set as one comparable value, so an effect runs when the rows change
  // and not on every render that happens to rebuild the array.
  const rowsKey = rows.join(',');

  // The rows as of the last render, readable from a callback that started in
  // an earlier one. A click's row is captured when the handler is created,
  // and the settings can move under it while the request is in flight.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Dropped, not merely hidden, once the row it belongs to is off the page.
  // Keeping it would bring a message about an attempt made minutes ago back
  // under the original row if the setting were toggled off and on again
  // elsewhere.
  useEffect(() => {
    const showing = new Set(rowsKey === '' ? [] : rowsKey.split(','));
    setFailure((current) => (current === null || showing.has(current.row) ? current : null));
    setConfirming((current) => (current === null || showing.has(current) ? current : null));
  }, [rowsKey]);

  // The store keeps the old settings when the PATCH is rejected, so a failure
  // leaves the strip as it was and the message sits under the row it was
  // raised on until the next attempt.
  const runAction = async (startedOn: DiscoveryHintRow, change: () => Promise<void>) => {
    setPending(startedOn);
    setFailure(null);
    try {
      await change();
    } catch (err) {
      // The row this attempt was made on can be gone by the time the request
      // answers, dropped by a WS ready or another tab. Recording the failure
      // then would store a message the effect above never sees (the row it
      // names is not on the page, and the set does not change again on the
      // way in), leaving it to surface the next time that row came back.
      if (!rowsRef.current.includes(startedOn)) return;
      const message = err instanceof Error ? describeError(err) : t('spaces:explore.discoveryOff.failed');
      setFailure({ row: startedOn, message });
    } finally {
      setPending(null);
      // The question has been answered either way. A refusal is reported
      // under the row, which is where every other failure on this surface is
      // reported, and not behind a dialog that would have to be dismissed to
      // read it.
      setConfirming(null);
    }
  };

  // Whether the instance is invite-only. Two things turn on it: the click
  // below writes the discovery flag as well, and the confirmation in front of
  // it has to say so.
  const discoveryOff = streamingLimits !== null && !streamingLimits.discoveryEnabled;

  const handleEnableDiscovery = () => runAction('discoveryOffAdmin', async () => {
    await updateInstanceSettings({ discoveryEnabled: true });
    onDiscoveryEnabled();
  });

  const handleEnableBrowse = () => runAction('browseOffAdmin', async () => {
    await updateInstanceSettings({ directoryBrowseEnabled: true });
    // This row names a fact of the public instance info, which the settings
    // document the PATCH answers with does not carry, so it goes only once
    // the page has re-read that info. Awaited so the button stays disabled
    // until it does, rather than re-enabling under a row about to go.
    await onBrowseEnabled();
  });

  const handleListSpaces = () => runAction('notListed', async () => {
    // The whole global rung, not the listing flag alone. `directoryEnabled`
    // without `discoveryEnabled` is the pair the server refuses with
    // `directory_requires_discovery`, and this row is offered whether or not
    // discovery is on, so sending the flag by itself would be an action that
    // fails by construction on an invite-only instance. Nothing to refetch
    // afterwards: what this instance lists does not change what it sees, and
    // the discovery half is reported by the row above, which goes on the same
    // answer.
    await updateInstanceSettings({ discoveryEnabled: true, directoryEnabled: true });
    // Only when that half of the write actually changed something: what this
    // instance lists does not change what it sees, so a listing on an
    // instance that was already discoverable refetches nothing.
    if (discoveryOff) onDiscoveryEnabled();
  });

  if (rows.length === 0) return null;

  const textOf = (row: DiscoveryHintRow): string => {
    switch (row) {
      case 'discoveryOffAdmin': return t('spaces:explore.discoveryOff.admin');
      case 'discoveryOffMember': return t('spaces:explore.discoveryOff.member');
      case 'notListed': return t('spaces:explore.notListed.text');
      // The two browse rows state the one fact in two voices, like the two
      // discovery rows above them. A member cannot act on it, so the sentence
      // has to say that the state is their administrator's choice rather than
      // a fault: an unexplained absence reads as something broken. An admin
      // knows they chose it and is told the fact alone, next to the switch.
      case 'browseOffMember': return t('spaces:explore.browseOff.member');
      default: return t('spaces:explore.browseOff.admin');
    }
  };

  // Two of the three actions are asked about before they run. Space discovery
  // is not: it is local to this instance, reveals nothing outward and is
  // undone by the same control, so a dialog in front of it would be noise
  // that teaches the admin to click past the two that matter.
  const actionOf = (row: DiscoveryHintRow): { label: string; onClick: () => void } | null => {
    switch (row) {
      case 'discoveryOffAdmin':
        return { label: t('spaces:explore.discoveryOff.enable'), onClick: handleEnableDiscovery };
      case 'browseOffAdmin':
        return { label: t('spaces:explore.browseOff.action'), onClick: () => setConfirming('browseOffAdmin') };
      case 'notListed':
        return { label: t('spaces:explore.notListed.action'), onClick: () => setConfirming('notListed') };
      default:
        return null;
    }
  };

  return (
    <div className="mb-4 rounded-lg bg-white/[0.03] border border-white/[0.04] divide-y divide-white/[0.04]">
      {rows.map((row) => {
        const action = actionOf(row);
        const message = failure !== null && failure.row === row ? failure.message : '';
        return (
          <div key={row} className="px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              {/* On a phone the sentence takes the whole line, so every row
                  in the stack puts its action underneath rather than one row
                  keeping it alongside because its sentence happened to be
                  short. On the desktop shell the action trails the text as
                  before. The variant is the project's `data-viewport` one,
                  not a Tailwind breakpoint: this app decides mobile from the
                  layout width at the current interface scale, not from the
                  raw viewport. */}
              <p className={`w-full desktop:w-auto desktop:flex-1 desktop:min-w-[14rem] text-[13px] ${isWarningRow(row) ? 'text-accent-amber' : 'text-txt-tertiary'}`}>
                {textOf(row)}
              </p>
              {action !== null && (
                <button
                  type="button"
                  onClick={action.onClick}
                  // Only the row whose write is in flight: a stacked strip
                  // must not disable the neighbour's unrelated action.
                  disabled={pending === row}
                  className="shrink-0 text-[13px] text-accent-primary hover:text-accent-primary/80 font-medium transition-colors disabled:text-txt-tertiary disabled:cursor-default"
                >
                  {action.label}
                </button>
              )}
            </div>
            {message && <p className="mt-1 text-[13px] text-txt-danger">{message}</p>}
          </div>
        );
      })}
      {rows.includes('browseOffAdmin') && (
        <ShowGlobalSpacesConfirm
          isOpen={confirming === 'browseOffAdmin'}
          onClose={() => setConfirming(null)}
          onConfirm={handleEnableBrowse}
          loading={pending === 'browseOffAdmin'}
        />
      )}
      {rows.includes('notListed') && (
        <ListInDirectoryConfirm
          isOpen={confirming === 'notListed'}
          onClose={() => setConfirming(null)}
          onConfirm={handleListSpaces}
          loading={pending === 'notListed'}
          intro={discoveryOff ? t('spaces:settings.discovery.directory.adminOffSelfIntro') : undefined}
        />
      )}
    </div>
  );
}
