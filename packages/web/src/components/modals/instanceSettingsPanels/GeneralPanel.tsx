import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { Toggle } from '../../ui/Toggle';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';
import type { DirectoryPingError, InstanceAdminSettings } from '@backspace/shared';

const INSTANCE_NAME_MAX_LENGTH = 32;

/**
 * How often the panel re-reads the instance settings while it is open, so
 * the directory status line follows the pinger: the change ping lands a few
 * seconds after a save, the daily ping and any failure later.
 */
export const INSTANCE_SETTINGS_REFRESH_MS = 10_000;

/** The fields this panel edits; everything else is read live from the store. */
interface InstanceDraft {
  instanceName: string;
  discoveryEnabled: boolean;
  directoryEnabled: boolean;
  directoryBrowseEnabled: boolean;
}

function draftFrom(settings: InstanceAdminSettings): InstanceDraft {
  return {
    instanceName: settings.instanceName,
    discoveryEnabled: settings.discoveryEnabled,
    directoryEnabled: settings.directoryEnabled,
    directoryBrowseEnabled: settings.directoryBrowseEnabled,
  };
}

function sameDraft(a: InstanceDraft, b: InstanceDraft): boolean {
  return a.instanceName === b.instanceName
    && a.discoveryEnabled === b.discoveryEnabled
    && a.directoryEnabled === b.directoryEnabled
    && a.directoryBrowseEnabled === b.directoryBrowseEnabled;
}

type PingReasonKey =
  `admin:general.directory.reasons.${NonNullable<DirectoryPingError['reason']> | 'origin' | 'network' | 'timeout'}`;

/**
 * The key under `admin:general.directory.reasons` that explains a failed ping,
 * or null when the status speaks for itself. A hub that could not read this
 * instance's document says why in `reason`; a hub that refused the address, or
 * a ping that never got an answer, says so in `status`. A plain HTTP status is
 * shown as the number it is.
 */
function pingReasonKey(error: DirectoryPingError): PingReasonKey | null {
  if (typeof error.status === 'number') return null;
  if (error.status === 'fetch') {
    return error.reason ? `admin:general.directory.reasons.${error.reason}` : null;
  }
  return `admin:general.directory.reasons.${error.status}`;
}

/**
 * How far spaces on this instance can be found. One ladder with three rungs,
 * each a superset of the one above, standing in for the two stored booleans:
 * an admin never has to work out which pair of switches means what, and the
 * pair the server refuses (`directory_requires_discovery`) cannot be
 * expressed here at all.
 */
type DiscoveryLevel = 'invite' | 'local' | 'global';

/** The rungs in ladder order, with the catalog keys that name each one. */
const DISCOVERY_LEVELS = [
  {
    level: 'invite',
    labelKey: 'admin:general.discovery.levels.invite.label',
    descriptionKey: 'admin:general.discovery.levels.invite.description',
  },
  {
    level: 'local',
    labelKey: 'admin:general.discovery.levels.local.label',
    descriptionKey: 'admin:general.discovery.levels.local.description',
  },
  {
    level: 'global',
    labelKey: 'admin:general.discovery.levels.global.label',
    descriptionKey: 'admin:general.discovery.levels.global.description',
  },
] as const;

/** What each rung stores. The invalid pair has no rung, so no save can send it. */
const LEVEL_FLAGS: Record<DiscoveryLevel, { discoveryEnabled: boolean; directoryEnabled: boolean }> = {
  invite: { discoveryEnabled: false, directoryEnabled: false },
  local: { discoveryEnabled: true, directoryEnabled: false },
  global: { discoveryEnabled: true, directoryEnabled: true },
};

/**
 * The rung the draft currently sits on. Derived, never stored: a third piece
 * of state would be one more thing that can disagree with the two booleans
 * the save actually sends.
 */
function levelOf(draft: { discoveryEnabled: boolean; directoryEnabled: boolean }): DiscoveryLevel {
  if (!draft.discoveryEnabled) return 'invite';
  return draft.directoryEnabled ? 'global' : 'local';
}

/**
 * What one `GET /api/instance/info` answer says about this instance having a
 * `DIRECTORY_ENDPOINT`: true it has one, false it has none, null nothing new
 * was learned.
 *
 * The server reports one flag, `directoryAvailable`, which is the endpoint and
 * the admin's browse setting together, so neither half means anything read on
 * its own. They are reduced here, once, to the single fact the row needs, and
 * it is that fact that is stored. Storing the raw flag instead splits the
 * pair: a save writes the setting immediately and the flag is a round trip
 * behind it, so for the length of that round trip the panel would answer from
 * one value before the change and one after, and tell an admin who just
 * switched browsing on that the instance has no directory.
 *
 * The two halves are not read at the same instant, and cannot be: the server
 * reads its half when it handles the request, the client reads its half when
 * the answer arrives. What makes the pairing sound is the caller's job, not
 * this function's, and it is written down at the one place that does it, the
 * probe effect in `GeneralPanel`. In short: the setting is captured when the
 * request goes out and compared when it comes back, and an answer is used
 * only when the two agree.
 *
 * The reduction is then stable for as long as the panel is open: no setting an
 * admin can write creates or removes an endpoint, so an established answer is
 * never invalidated by a later change. `previous` is returned when this answer
 * settles nothing, which is an unavailable directory while browsing is off:
 * the endpoint and the setting are then indistinguishable causes, and a fact
 * already established is worth more than the absence of one.
 */
function endpointFrom(directoryAvailable: boolean, browseEnabled: boolean, previous: boolean | null): boolean | null {
  if (directoryAvailable) return true;
  return browseEnabled ? false : previous;
}

export function GeneralPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);

  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<InstanceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [gifKeyDirty, setGifKeyDirty] = useState(false);
  const [gifKeyDraft, setGifKeyDraft] = useState('');
  const [openingRegistration, setOpeningRegistration] = useState(false);

  // Whether this instance has a DIRECTORY_ENDPOINT to reach, or null while
  // that cannot be told. Stored already derived, never as the raw
  // `directoryAvailable` half: see `endpointFrom` for why the derivation has
  // to happen at the instant the answer arrives.
  const [hasDirectoryEndpoint, setHasDirectoryEndpoint] = useState<boolean | null>(null);
  // Bumped after a save so the answer follows a change the admin just made.
  const [directoryProbe, setDirectoryProbe] = useState(0);
  // The settings the draft was last seeded from. A background refresh only
  // reseeds the draft while it still equals this, so an unsaved edit survives
  // the 10 second poll and a save or reset is what moves it on.
  const seededFrom = useRef<InstanceDraft | null>(null);
  const isDirty = gifKeyDirty
    || (draft !== null && seededFrom.current !== null && !sameDraft(draft, seededFrom.current));

  useEffect(() => {
    if (!instanceSettings) return;
    const next = draftFrom(instanceSettings);
    // A draft that already equals what the server holds (an untouched one,
    // or an edit that arrived there through another writer) takes the new
    // values as its seed, so later changes elsewhere keep reaching it; there
    // is nothing to copy, so no new draft object and no re-render each poll.
    if (draft !== null && sameDraft(draft, next)) {
      seededFrom.current = next;
      return;
    }
    if (isDirty) return;
    seededFrom.current = next;
    setDraft(next);
    setGifKeyDraft('');
    setGifKeyDirty(false);
    // A refresh that leaves the editable fields alone must not reseed a draft
    // the user is typing in; `draft` and `isDirty` are read at the moment
    // the settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceSettings]);

  // The reduction needs both halves, so there is nothing to ask until the
  // settings are here. The modal renders this panel in the same commit as the
  // effect that fetches them, and a child's effects run before its parent's,
  // so on a first open the request would otherwise go out against an empty
  // store, read the browse setting as off, learn nothing, and stay unknown:
  // the 10 second poll fills the settings in but never asks again. The gate
  // only goes false to true while the panel is open, so it costs one deferred
  // request and no repeated ones.
  const settingsLoaded = instanceSettings !== null;

  /**
   * The endpoint probe, and the one place the pairing rule lives.
   *
   * `directoryAvailable` is the endpoint and the browse setting together, so
   * an answer is only worth anything beside the setting the server had when
   * it answered. The setting is therefore captured when the request goes out
   * and compared when it comes back; if it no longer matches, the answer is
   * refused, because it describes a pair that no longer exists.
   *
   * Capturing rather than trusting the store at either end matters because
   * the setting does not move only through this panel's own save. The 10
   * second poll and the settings modal's own mount fetch both write it, and
   * either can carry a change made by another admin, another tab or a direct
   * API call, with nothing here to know it happened. A comparison catches all
   * of them; an epoch counter bumped by this panel's save caught only its
   * own, and refused a save that merely renamed the instance.
   *
   * A refused answer leaves `hasDirectoryEndpoint` alone, so the row keeps
   * whatever was last established rather than falling back to a claim. The
   * rest of the reasoning, including the known limit that nothing asks again
   * after a refusal no save caused, is in docs/systems/directory.md section
   * 10.
   */
  useEffect(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    const askedWith = useSettingsStore.getState().instanceSettings?.directoryBrowseEnabled === true;
    api.instance.info()
      .then((info) => {
        if (cancelled) return;
        const answeredWith = useSettingsStore.getState().instanceSettings?.directoryBrowseEnabled === true;
        if (answeredWith !== askedWith) return;
        setHasDirectoryEndpoint((previous) => endpointFrom(
          info.directoryAvailable === true,
          answeredWith,
          previous,
        ));
      })
      .catch(() => {
        // Nothing learned, so nothing unsaid. A re-read that fails must not
        // retract an answer that was right: an instance whose own info
        // endpoint is momentarily unreachable has not grown an endpoint, nor
        // lost one.
      });
    return () => { cancelled = true; };
  }, [directoryProbe, settingsLoaded]);

  // The directory status line follows the pinger while the panel is open.
  useEffect(() => {
    const timer = setInterval(() => { void fetchInstanceSettings(); }, INSTANCE_SETTINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchInstanceSettings]);

  if (!draft || !instanceSettings) {
    return <div className="text-sm text-txt-tertiary">{t('common:states.loadingSettings')}</div>;
  }

  const hasChanges = gifKeyDirty || !sameDraft(draft, draftFrom(instanceSettings));

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Partial<InstanceAdminSettings> = {
        instanceName: draft.instanceName,
        discoveryEnabled: draft.discoveryEnabled,
        directoryEnabled: draft.directoryEnabled,
        directoryBrowseEnabled: draft.directoryBrowseEnabled,
      };
      if (gifKeyDirty) {
        payload.gifApiKey = gifKeyDraft;
      }
      await updateInstanceSettings(payload);
      // The server's answer is the new baseline, whatever it normalised. A
      // poll dispatched before the save and answered after it can reseed the
      // pre-save values for one interval; the next poll corrects it.
      const saved = useSettingsStore.getState().instanceSettings;
      if (saved) {
        const next = draftFrom(saved);
        seededFrom.current = next;
        setDraft(next);
      }
      setGifKeyDirty(false);
      setGifKeyDraft('');
      // Ask again, now that the setting has settled. An answer still in flight
      // from before the save is refused by the probe effect's own comparison
      // if the save moved the setting, and correctly kept if it did not.
      setDirectoryProbe((n) => n + 1);
      addToast(t('common:states.settingsSaved'), 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? describeError(err) : t('common:states.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const level = levelOf(draft);

  // Picking a rung writes both booleans from that rung's row. There is no
  // combination left that the server would refuse, so no clearing special
  // case either.
  const selectLevel = (next: DiscoveryLevel) => {
    setDraft({ ...draft, ...LEVEL_FLAGS[next] });
  };

  /**
   * Opens federated account creation straight away, outside the draft.
   *
   * Deliberately a click and not a side effect of picking the global rung:
   * letting strangers create accounts here is a security decision of its own,
   * and a listing that silently opened sign-ups would be the kind of surprise
   * an admin never forgives.
   */
  const handleOpenFederatedRegistration = async () => {
    setOpeningRegistration(true);
    setSaveError('');
    try {
      await updateInstanceSettings({ federatedRegistrationOpen: true });
    } catch (err) {
      setSaveError(err instanceof Error ? describeError(err) : t('common:states.saveFailed'));
    } finally {
      setOpeningRegistration(false);
    }
  };

  // Known to have no directory to reach. Only the established `false` counts:
  // null is "not known", which the row renders as neither claim, the same as
  // a reachable directory.
  const noDirectoryEndpoint = hasDirectoryEndpoint === false;

  const lastError = instanceSettings.directoryLastError;
  const lastErrorReasonKey = lastError === null ? null : pingReasonKey(lastError);
  const pingLabel = instanceSettings.directoryLastPingAt === null
    ? t('admin:general.directory.status.never')
    : t('admin:general.directory.status.lastPing', { date: f.formatDateTime(instanceSettings.directoryLastPingAt) });

  const handleReset = () => {
    const next = draftFrom(instanceSettings);
    seededFrom.current = next;
    setDraft(next);
    setGifKeyDirty(false);
    setGifKeyDraft('');
    setSaveError('');
  };

  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">{t('admin:general.title')}</h2>
      <div className="text-xs text-txt-tertiary">
        {t('admin:general.description')}
      </div>

      {/* Instance Name */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:general.instanceName.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('admin:general.instanceName.description')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <input
            type="text"
            value={draft.instanceName}
            onChange={(e) => setDraft({ ...draft, instanceName: e.target.value.slice(0, INSTANCE_NAME_MAX_LENGTH) })}
            placeholder={t('common:appName')}
            aria-label={t('admin:general.instanceName.label')}
            className="input-standard w-full"
          />
          <div className="text-[11px] text-txt-tertiary text-right mt-1">
            {t('admin:general.instanceName.counter', { length: draft.instanceName.length, max: INSTANCE_NAME_MAX_LENGTH })}
          </div>
        </div>
      </div>

      {/* Space discovery: one ladder, three rungs */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:general.discovery.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('admin:general.discovery.description')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          {/*
            The group owns the three rungs and nothing else: a `radiogroup` may
            own only radios, so what hangs under the global rung is a sibling of
            the fieldset, indented to line up under it. `global` is the last
            rung, so this renders exactly where it reads.
          */}
          <fieldset role="radiogroup" aria-label={t('admin:general.discovery.label')} className="min-w-0 space-y-1.5">
            {DISCOVERY_LEVELS.map((option) => (
              <label
                key={option.level}
                className={`flex items-start gap-3 p-2.5 rounded cursor-pointer transition-colors ${
                  level === option.level ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
                }`}
              >
                <input
                  type="radio"
                  name="instance-discovery-level"
                  value={option.level}
                  checked={level === option.level}
                  onChange={() => selectLevel(option.level)}
                  aria-label={t(option.labelKey)}
                  aria-describedby={`discovery-level-${option.level}-description`}
                  className="mt-0.5 accent-accent-primary"
                />
                <div>
                  <div className="text-sm font-medium text-txt-primary">{t(option.labelKey)}</div>
                  <div id={`discovery-level-${option.level}-description`} className="text-xs text-txt-tertiary">
                    {t(option.descriptionKey)}
                  </div>
                </div>
              </label>
            ))}
          </fieldset>
          {level === 'global' && (
            <div className="ml-9 mr-2.5 mt-1.5 mb-1 space-y-3">
              {!instanceSettings.federatedRegistrationOpen && (
                <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber space-y-2">
                  <p>{t('admin:general.directory.registrationClosed')}</p>
                  <button
                    type="button"
                    onClick={handleOpenFederatedRegistration}
                    disabled={openingRegistration}
                    className="px-2.5 py-1 rounded bg-accent-amber/20 hover:bg-accent-amber/30 text-[13px] font-medium transition-colors disabled:opacity-50"
                  >
                    {t('admin:general.directory.openFederatedRegistration')}
                  </button>
                </div>
              )}
              {/* What the pinger last did, the same shape as the telemetry panel's line */}
              <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3 space-y-1">
                <div className="text-xs text-txt-tertiary">{pingLabel}</div>
                {lastError !== null && (
                  <div className="text-xs text-txt-danger">
                    {t('admin:general.directory.status.lastError', {
                      status: lastErrorReasonKey === null ? lastError.status : t(lastErrorReasonKey),
                    })}
                  </div>
                )}
              </div>
              <p className="text-xs text-txt-tertiary">{t('admin:general.directory.disclosure')}</p>
            </div>
          )}
          {/*
            The other direction. The ladder is how far spaces here travel; this
            row is what the people here are shown, and neither gates the other,
            so it reads as its own row under a rule rather than as a fourth
            rung of a ladder it does not belong to.
          */}
          <div className="mt-3 pt-3 border-t border-white/[0.04]">
            <label className={`flex items-center justify-between gap-3 ${noDirectoryEndpoint ? '' : 'cursor-pointer'}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary">{t('admin:general.browse.toggleLabel')}</div>
                <div className="text-xs text-txt-tertiary mt-0.5">{t('admin:general.browse.toggleDescription')}</div>
              </div>
              {/*
                The switch shows the effective state, not the stored column.
                With no endpoint to reach, nothing is browsed whatever the
                column says, so a switch in the on position next to a line
                saying there is nothing to show would assert two things at
                once and only one of them would be true. The column is not
                written to match: the stored value is invisible and harmless
                while there is no endpoint, and browsing resumes at whatever
                the admin last chose if one is ever configured. Do not
                "correct" this into reflecting the raw draft.
              */}
              <Toggle
                enabled={draft.directoryBrowseEnabled && !noDirectoryEndpoint}
                onChange={(value) => setDraft({ ...draft, directoryBrowseEnabled: value })}
                disabled={noDirectoryEndpoint}
                ariaLabel={t('admin:general.browse.toggleLabel')}
              />
            </label>
            {noDirectoryEndpoint && (
              <p className="mt-2 text-xs text-txt-tertiary">{t('admin:general.browse.unavailable')}</p>
            )}
          </div>
        </div>
      </div>

      {/* GIF Search */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('admin:general.gif.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">
          {t('admin:general.gif.description')}
        </p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2">
          <input
            type="password"
            value={gifKeyDirty ? gifKeyDraft : ''}
            onChange={(e) => { setGifKeyDraft(e.target.value); setGifKeyDirty(true); }}
            placeholder={instanceSettings.gifEnabled ? t('admin:general.gif.placeholderSaved') : t('admin:general.gif.placeholderKey')}
            className="input-standard w-full"
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
              instanceSettings.gifEnabled ? 'bg-status-online/15 text-status-online' : 'bg-white/5 text-txt-tertiary'
            }`}>
              {instanceSettings.gifEnabled ? t('admin:general.gif.enabled') : t('admin:general.gif.notConfigured')}
            </span>
            {instanceSettings.gifEnabled && !gifKeyDirty && (
              <button
                onClick={() => { setGifKeyDraft(''); setGifKeyDirty(true); }}
                className="text-[11px] text-txt-tertiary hover:text-txt-danger transition-colors"
              >
                {t('admin:general.gif.clearKey')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status messages */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {/* Save / Reset bar */}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                {t('common:actions.reset')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? t('common:states.saving') : t('common:actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
