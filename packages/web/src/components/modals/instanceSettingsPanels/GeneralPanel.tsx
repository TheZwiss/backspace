import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { Toggle } from '../../ui/Toggle';
import { DirectoryListingHint } from './DirectoryListingHint';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';
import { invalidateHomeInstanceInfo } from '../../../hooks/useHomeInstanceInfo';
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
  supportCardEnabled: boolean;
}

function draftFrom(settings: InstanceAdminSettings): InstanceDraft {
  return {
    instanceName: settings.instanceName,
    discoveryEnabled: settings.discoveryEnabled,
    directoryEnabled: settings.directoryEnabled,
    directoryBrowseEnabled: settings.directoryBrowseEnabled,
    supportCardEnabled: settings.supportCardEnabled,
  };
}

function sameDraft(a: InstanceDraft, b: InstanceDraft): boolean {
  return a.instanceName === b.instanceName
    && a.discoveryEnabled === b.discoveryEnabled
    && a.directoryEnabled === b.directoryEnabled
    && a.directoryBrowseEnabled === b.directoryBrowseEnabled
    && a.supportCardEnabled === b.supportCardEnabled;
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

  // Whether the operator gave this instance a DIRECTORY_ENDPOINT, or null
  // while the answer has not arrived. Reported on its own by the public
  // instance info, so it is read and rendered; it is not derived from
  // anything the admin can change here, and nothing in this panel can move
  // it, so it is asked once.
  const [hasDirectoryEndpoint, setHasDirectoryEndpoint] = useState<boolean | null>(null);
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

  // One read of one fact. The server reports `directoryConfigured` on its
  // own, so there is nothing to pair it with and nothing that can move it
  // under this panel: no setting an admin writes creates or removes an
  // endpoint. A failed request leaves it unknown, which the row renders as
  // neither claim.
  useEffect(() => {
    let cancelled = false;
    api.instance.info()
      .then((info) => { if (!cancelled) setHasDirectoryEndpoint(info.directoryConfigured === true); })
      .catch(() => {
        // Unknown. An instance whose own info endpoint is unreachable has
        // bigger news than this row, and a guess here would be a claim.
      });
    return () => { cancelled = true; };
  }, []);

  // The directory status line follows the pinger while the panel is open.
  useEffect(() => {
    const timer = setInterval(() => { void fetchInstanceSettings(); }, INSTANCE_SETTINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchInstanceSettings]);

  if (!draft || !instanceSettings) {
    return <div className="text-sm text-txt-tertiary">{t('common:states.loadingSettings')}</div>;
  }

  const hasChanges = gifKeyDirty || !sameDraft(draft, draftFrom(instanceSettings));

  /** Saves the draft; resolves true when the server took it. */
  const handleSave = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Partial<InstanceAdminSettings> = {
        instanceName: draft.instanceName,
        discoveryEnabled: draft.discoveryEnabled,
        directoryEnabled: draft.directoryEnabled,
        directoryBrowseEnabled: draft.directoryBrowseEnabled,
        supportCardEnabled: draft.supportCardEnabled,
      };
      if (gifKeyDirty) {
        payload.gifApiKey = gifKeyDraft;
      }
      await updateInstanceSettings(payload);
      // The Backspace page reads the instance name and the Support card
      // switch from its own cached copy of the public info; reread it so the
      // change shows there without a reload.
      invalidateHomeInstanceInfo();
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
      addToast(t('common:states.settingsSaved'), 'success', 2000);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? describeError(err) : t('common:states.saveFailed'));
      return false;
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
            {DISCOVERY_LEVELS.map((option) => {
              /*
                The global rung promises the public directory, which needs a
                DIRECTORY_ENDPOINT the operator may not have given. Without
                one, no pinger runs and no hub is ever told, so the rung is
                not offered and its description is replaced by the reason
                rather than left saying spaces appear everywhere.

                Unlike the browse switch below, a rung that is already stored
                as selected still reads as selected, and the difference is not
                inconsistency. The switch renders off because with no endpoint
                nothing is browsed, so off is what is in effect. The rung
                cannot say the same: `buildDirectoryDocument` gates the public
                document on `directory_enabled` and `discovery_enabled` alone
                and never on the endpoint, and `GET /api/directory/spaces` is
                unauthenticated, so an endpoint-less instance stored at the
                global rung is genuinely serving a populated public document
                of its listed spaces right now. The only thing missing is a
                hub fetching it. Rendering `local` as checked would hide a
                live fact about what this instance publishes. The admin can
                always step down from the rung, which stops the document
                being populated; they simply cannot step up into a level whose
                remaining half would do nothing.
              */
              const dead = option.level === 'global' && noDirectoryEndpoint;
              return (
              <label
                key={option.level}
                className={`flex items-start gap-3 p-2.5 rounded transition-colors ${
                  dead ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                } ${level === option.level ? 'bg-interactive-selected' : dead ? '' : 'hover:bg-interactive-hover'}`}
              >
                <input
                  type="radio"
                  name="instance-discovery-level"
                  value={option.level}
                  checked={level === option.level}
                  disabled={dead}
                  onChange={() => selectLevel(option.level)}
                  aria-label={t(option.labelKey)}
                  aria-describedby={`discovery-level-${option.level}-description`}
                  className="mt-0.5 accent-accent-primary"
                />
                <div>
                  <div className="text-sm font-medium text-txt-primary">{t(option.labelKey)}</div>
                  <div id={`discovery-level-${option.level}-description`} className="text-xs text-txt-tertiary">
                    {dead ? t('admin:general.discovery.unconfigured') : t(option.descriptionKey)}
                  </div>
                </div>
              </label>
              );
            })}
          </fieldset>
          {level === 'global' && (
            <div className="ml-9 mr-2.5 mt-1.5 mb-1 space-y-3">
              {/*
                Gated on the endpoint for the same reason the rung above it
                is. The note warns that listed spaces will show as closed to
                new accounts, and offers to open federated registration to fix
                it; with no endpoint nothing here reaches a hub, so it would
                be urging a security decision to head off a consequence that
                cannot happen, directly under a rung that has just said so.

                The ping line and the disclosure below are not gated, because
                both stay true: the document really is built and served (see
                the comment on the rung), so what it discloses is public and
                the pinger's own history is worth reading.
              */}
              {/*
                The rung allows listing and lists nothing by itself, which is
                the one thing admins picking it kept missing. Said only while
                no space here has opted in: once one has, the count in the
                status line below answers the same question. Gated on the
                endpoint for the same reason as the note after it.
              */}
              {instanceSettings.directoryListedSpaceCount === 0 && !noDirectoryEndpoint && (
                <DirectoryListingHint saveFirst={hasChanges ? handleSave : null} saving={saving} />
              )}
              {!instanceSettings.federatedRegistrationOpen && !noDirectoryEndpoint && (
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
                {instanceSettings.directoryListedSpaceCount > 0 && (
                  <div className="text-xs text-txt-tertiary">
                    {t('admin:general.directory.listedCount', { count: instanceSettings.directoryListedSpaceCount })}
                  </div>
                )}
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

      {/*
        The Support card on the Backspace page. Hides only that card: the
        page's other links stay, and the card is also absent until the
        project has a Ko-fi link to point it at.
      */}
      <div className="rounded-lg bg-white/[0.02] p-3.5">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <div className="min-w-0">
            <div className="text-sm font-medium text-txt-primary">{t('admin:general.supportCard.toggleLabel')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">{t('admin:general.supportCard.toggleDescription')}</div>
          </div>
          <Toggle
            enabled={draft.supportCardEnabled}
            onChange={(value) => setDraft({ ...draft, supportCardEnabled: value })}
            ariaLabel={t('admin:general.supportCard.toggleLabel')}
          />
        </label>
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
