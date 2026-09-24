import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '../../i18n/formatters';
import { describeError } from '../../i18n/errors';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Avatar } from '../ui/Avatar';
import { Toggle } from '../ui/Toggle';
import { api } from '../../api/client';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { OverviewPanel } from './spaceSettingsPanels/OverviewPanel';
import { MembersPanel } from './spaceSettingsPanels/MembersPanel';
import { RolesPanel } from './spaceSettingsPanels/RolesPanel';
import { BansPanel } from './spaceSettingsPanels/BansPanel';
import { useVisibilityOptions } from './spaceSettingsPanels/spaceOptions';
import { ListInDirectoryConfirm } from './DirectoryConfirmations';
import type { SpaceVisibility, JoinRequest, InstanceStreamingLimits } from '@backspace/shared';

const DESCRIPTION_MAX_LENGTH = 200;

/** The three instance facts the Discovery panel gates its switches on. */
interface InstanceDiscoveryFlags {
  discoveryEnabled: boolean;
  /** The admin's listing opt-in. */
  directoryEnabled: boolean;
  /** The instance has a `DIRECTORY_ENDPOINT`, so a listing can reach a hub. */
  directoryConfigured: boolean;
}

/** The three fields of a streaming-settings document this panel reads. */
function flagsOf(limits: InstanceStreamingLimits): InstanceDiscoveryFlags {
  return {
    discoveryEnabled: limits.discoveryEnabled,
    directoryEnabled: limits.directoryEnabled,
    directoryConfigured: limits.directoryConfigured,
  };
}

/** What the Discovery panel knows about the instance its space lives on. */
interface InstanceDiscoveryFlagsState {
  /** The flags, or null while they are not known. */
  flags: InstanceDiscoveryFlags | null;
  /** A load this hook ran finished and left nothing to show. */
  failed: boolean;
  /** A load is running, so Retry is inert rather than re-entrant. */
  loading: boolean;
  /** Ask again. The only way back when the document did not arrive. */
  retry: () => void;
}

/**
 * The discovery and directory flags of the instance a space lives on, the
 * state of the load that fetches them, and the way to ask again.
 *
 * Home (`''`) reads the store's `streamingLimits`, the settings document any
 * signed-in user may fetch. That field is null until the document arrives and
 * stays null when the request fails, and null is not a fact: defaulting it
 * (`?? true` / `?? false`) told an owner their space was not listed, and
 * locked the switch that says so, on the strength of a document nobody had
 * read. `InstanceDiscoveryHint` states nothing from a null document for the
 * same reason; this panel offers a write off these flags, so it has more at
 * stake, not less.
 *
 * **It fetches the document itself when it is missing.** One WS `ready`
 * handler fills that field for the whole session, and nothing else does for a
 * member (the Streaming panel is an admin surface). A `ready` whose fetch
 * failed therefore left this panel with an unexplained disabled switch for
 * the rest of the session, which is unknown saying nothing at all rather than
 * saying it is unknown. The load runs only when the field is empty, since the
 * panel reads the document and does not write it, and `failed` plus `retry`
 * carry the rest, the same treatment the Streaming panel gives its own load.
 *
 * A remote space asks its own instance through its own client on mount,
 * because home's flags say nothing about it: null while that answer is
 * pending, so the caller can keep its switches disabled rather than show
 * home's values. A failed fetch falls back to the store's values and lets the
 * save's own error speak, which is null as well on an instance whose own
 * document never arrived, and that pair is what `failed` reports.
 */
function useInstanceDiscoveryFlags(origin: string): InstanceDiscoveryFlagsState {
  const homeLimits = useSettingsStore((s) => s.streamingLimits);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);
  const home: InstanceDiscoveryFlags | null = homeLimits === null ? null : flagsOf(homeLimits);
  const [remote, setRemote] = useState<{ origin: string; flags: InstanceDiscoveryFlags | 'failed' } | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  /**
   * The load whose answer this panel is still waiting for.
   *
   * The panel is not remounted when the space changes: `DiscoveryPanel` takes
   * `spaceId` from `spaceStore.currentSpaceId`, and the modal resets on
   * `isOpen` alone, so browser back or forward, or any other
   * `setCurrentSpace` while it is open, swaps one space's origin for
   * another's under a request that is already in flight. A late answer
   * writing anyway put the previous origin's flags in `remote`, which reads
   * as "this origin has not answered" against the new one: a disabled switch
   * with no reason line, no Retry, and no further load to correct it, since
   * the new origin's own load had already finished. Each loader takes a
   * number and writes nothing once another has started.
   */
  const runId = useRef(0);

  // `fetchStreamingLimits` swallows its own error, so the outcome is read
  // from the store: the document either arrived or it did not.
  const loadHome = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    await fetchStreamingLimits();
    if (runId.current !== id) return;
    setHomeFailed(useSettingsStore.getState().streamingLimits === null);
    setLoading(false);
  }, [fetchStreamingLimits]);

  const loadRemote = useCallback(async (target: string) => {
    const id = ++runId.current;
    setLoading(true);
    try {
      const limits = await getApiForOrigin(target).settings.getStreaming();
      if (runId.current !== id) return;
      setRemote({ origin: target, flags: flagsOf(limits) });
    } catch {
      if (runId.current !== id) return;
      setRemote({ origin: target, flags: 'failed' });
    } finally {
      // `loading` belongs to the newest load, so a superseded one leaves it
      // alone: clearing it here would say the panel had settled while the
      // load it is actually waiting for is still running.
      if (runId.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (origin) {
      void loadRemote(origin);
      return;
    }
    // Read through `getState` rather than from the render's `homeLimits`, so
    // the document arriving does not run this again.
    if (useSettingsStore.getState().streamingLimits === null) void loadHome();
  }, [origin, loadRemote, loadHome]);

  const retry = useCallback(() => {
    if (origin) void loadRemote(origin);
    else void loadHome();
  }, [origin, loadRemote, loadHome]);

  const remoteAnswered = remote !== null && remote.origin === origin;
  const flags = !origin
    ? home
    : !remoteAnswered
      ? null
      : remote.flags === 'failed' ? home : remote.flags;

  // Only a load that finished with nothing to show: a remote whose fetch
  // failed while home holds a document is not a failure this panel reports,
  // it is the fallback doing its job.
  const failed = flags === null && (origin ? remoteAnswered && remote.flags === 'failed' : homeFailed);

  return { flags, failed, loading, retry };
}

/**
 * Visibility, the directory switch and the description of one space. The save
 * goes through the store's `updateSpace`, which resolves the client for the
 * space's own instance and merges the answer back; a remote space must never
 * be saved through the home client. The instance flags come from the instance
 * the space lives on (`useInstanceDiscoveryFlags`): the store for a home
 * space, that instance's own `GET /settings/streaming` for a remote one.
 */
export function DiscoveryPanel({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(['spaces', 'common']);
  const visibilityOptions = useVisibilityOptions();
  const spaces = useSpaceStore((s) => s.spaces);
  const updateSpace = useSpaceStore((s) => s.updateSpace);
  const isHomeAdmin = useSettingsStore((s) => s.isAdmin);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const space = spaces.find(s => s.id === spaceId);
  const { flags, failed: flagsFailed, loading: flagsLoading, retry: retryFlags } =
    useInstanceDiscoveryFlags(space?._instanceOrigin ?? '');
  // Until the instance the space lives on has answered, neither flag is
  // known: the notice stays hidden and the directory switch stays disabled,
  // because a reason would be a guess about that instance. Unknown while a
  // load is still running says nothing; unknown because the load came back
  // empty says so, under the switch, with the way to ask again.
  const flagsUnknown = flags === null;
  // All three are read only on branches `flagsUnknown` already guards; the
  // fallbacks are what the type needs, never a claim about the instance.
  const discoveryEnabled = flags?.discoveryEnabled ?? false;
  const directoryEnabled = flags?.directoryEnabled ?? false;
  const directoryConfigured = flags?.directoryConfigured ?? false;

  const [visibility, setVisibility] = useState<SpaceVisibility>(
    (space?.visibility as SpaceVisibility) ?? 'private'
  );
  const [directoryListed, setDirectoryListed] = useState(space?.directoryListed ?? false);
  const [description, setDescription] = useState(space?.description ?? '');
  const addToast = useUIStore((s) => s.addToast);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // The instance-wide write offered under the reason below, and its own
  // failure. Separate from `saving`, which belongs to this space's save bar:
  // the two are different writes to different documents, and a refused rung
  // must not read as a refused space save.
  const [rungPending, setRungPending] = useState(false);
  const [rungError, setRungError] = useState('');
  const [confirmingRung, setConfirmingRung] = useState(false);

  useEffect(() => {
    if (space) {
      setVisibility((space.visibility as SpaceVisibility) ?? 'private');
      setDirectoryListed(space.directoryListed);
      setDescription(space.description ?? '');
    }
  }, [space]);

  if (!space) return null;

  const hasChanges =
    visibility !== ((space.visibility as SpaceVisibility) ?? 'private') ||
    directoryListed !== space.directoryListed ||
    description !== (space.description ?? '');

  // The server refuses a listed private space and clears the listing when a
  // space goes private; the draft does the same, so the switch never shows a
  // state the save would refuse and a save cannot silently lose the listing.
  const chooseVisibility = (next: SpaceVisibility) => {
    setVisibility(next);
    if (next === 'private') setDirectoryListed(false);
  };

  /**
   * Whether the person reading the "an administrator has to turn this on"
   * reason is that administrator, and may act on it from here.
   *
   * Admin rights are per instance. `settingsStore.isAdmin` is written from
   * the home instance's WS `ready` and from nowhere else: the handler reads
   * `event.user.isAdmin` only when the event came from home, and a remote
   * `ready` carrying it is discarded. There is no second signal either.
   * Nothing in `instanceStore` records a role per connection, and the one
   * route that would prove rights on another instance
   * (`GET /api/settings/instance`, admin-only) would have to be fired at that
   * instance on every panel open just to read its refusal, which is a request
   * nobody asked for and an answer that is 403 for the ordinary case.
   *
   * So the action is offered only where the client actually knows the answer:
   * a space whose home is this instance (`_instanceOrigin` empty, the same
   * value `useInstanceDiscoveryFlags` reads home by) and an admin here. For a
   * remote space the sentence stays exactly as it was, whatever this user is
   * at home, because being an admin here says nothing about rights there, and
   * because the write itself goes through `settingsStore`, which speaks to
   * home and to nowhere else. An admin of the remote instance changes it
   * there, on the Explore page of their own instance or in its settings.
   */
  const spaceIsHome = (space._instanceOrigin ?? '') === '';
  const canEnableRung = isHomeAdmin && spaceIsHome;

  // Always rendered: the reason under a disabled switch is what tells an owner
  // whose instance has the directory off, or whose space is private, what to do.
  // The endpoint is asked before the admin's opt-in, because it is the
  // deeper fact and the one the admin cannot change: on an instance with no
  // `DIRECTORY_ENDPOINT`, "your administrator has to turn this on" points an
  // owner at a switch that would not help. What is missing is a hub to fetch
  // the listing document, not the document, which this instance serves from
  // the two discovery flags either way.
  //
  // The opt-in reason has two voices. To an owner it names the person who has
  // to act; to the administrator reading their own instance's panel it names
  // the setting instead, because telling admins that an administrator has to
  // act is how this panel came to be a dead end for the one person who could
  // change it.
  const directoryReason = flagsUnknown
    ? null
    : !directoryConfigured
      ? t('spaces:settings.discovery.directory.notConfigured')
      : !directoryEnabled
        ? canEnableRung
          ? t('spaces:settings.discovery.directory.adminOffSelf')
          : t('spaces:settings.discovery.directory.adminOff')
        : visibility === 'private'
          ? t('spaces:settings.discovery.directory.privateSpace')
          : null;
  const directoryLocked = flagsUnknown || directoryReason !== null;
  // The reason that has a way out of it, which is the opt-in one and only for
  // an admin of the instance the space lives on. Derived, so it cannot be
  // offered under a reason that has moved on.
  const rungActionOffered = canEnableRung && !flagsUnknown && directoryConfigured && !directoryEnabled;

  /**
   * Turn on the global rung for this instance, which is what the reason above
   * names.
   *
   * Both flags, not just the listing one: `directoryEnabled` without
   * `discoveryEnabled` is the pair the server refuses
   * (`directory_requires_discovery`), and the rung the ladder in
   * Instance -> General calls global is exactly this pair. Writing one of them
   * from here would fail on an instance that is invite-only and would leave a
   * half-rung on one that is not.
   *
   * It goes through `settingsStore.updateInstanceSettings`, which speaks to
   * home. That is correct precisely because `canEnableRung` requires the
   * space to live here; the gate and the write agree about which instance
   * this is. The store mirrors the server's answer back into
   * `streamingLimits`, which for a home space is the document
   * `useInstanceDiscoveryFlags` reads, so the reason clears and the switch
   * unlocks on the next render with nothing to refetch.
   */
  const handleEnableRung = async () => {
    setRungPending(true);
    setRungError('');
    try {
      await updateInstanceSettings({ discoveryEnabled: true, directoryEnabled: true });
    } catch (err) {
      setRungError(describeError(err));
    } finally {
      setRungPending(false);
      setConfirmingRung(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateSpace(spaceId, { visibility, description: description.trim(), directoryListed });
      addToast(t('common:states.settingsSaved'), 'success', 2000);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setVisibility((space.visibility as SpaceVisibility) ?? 'private');
    setDirectoryListed(space.directoryListed);
    setDescription(space.description ?? '');
    setSaveError('');
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('spaces:settings.discovery.title')}</h2>
      {!flagsUnknown && !discoveryEnabled && (
        <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
          {t('spaces:settings.discovery.disabledNotice')}
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('spaces:settings.discovery.visibility.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('spaces:settings.discovery.visibility.hint')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <div className="space-y-1.5">
            {visibilityOptions.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-2.5 rounded cursor-pointer transition-colors ${
                  visibility === opt.value
                    ? 'bg-interactive-selected'
                    : 'hover:bg-interactive-hover'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={opt.value}
                  checked={visibility === opt.value}
                  onChange={() => chooseVisibility(opt.value)}
                  className="mt-0.5 accent-accent-primary"
                />
                <div>
                  <div className="text-sm font-medium text-txt-primary">{opt.label}</div>
                  <div className="text-xs text-txt-tertiary">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('spaces:explore.outer.title')}</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2.5">
          <label className={`flex items-center justify-between gap-4 ${directoryLocked ? 'cursor-default' : 'cursor-pointer'}`}>
            <div>
              <div className="text-sm font-medium text-txt-primary">{t('spaces:settings.discovery.directory.label')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">{t('spaces:settings.discovery.directory.hint')}</div>
            </div>
            <Toggle
              enabled={directoryListed}
              onChange={setDirectoryListed}
              disabled={directoryLocked}
              ariaLabel={t('spaces:settings.discovery.directory.label')}
            />
          </label>
          {directoryReason !== null && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <p className="text-xs text-txt-secondary">{directoryReason}</p>
              {rungActionOffered && (
                <button
                  type="button"
                  onClick={() => setConfirmingRung(true)}
                  disabled={rungPending}
                  className="text-xs font-medium text-accent-primary hover:text-accent-primary/80 transition-colors disabled:text-txt-tertiary disabled:cursor-default"
                >
                  {t('spaces:settings.discovery.directory.adminOffSelfAction')}
                </button>
              )}
            </div>
          )}
          {rungError && <p className="text-xs text-txt-danger">{rungError}</p>}
          {rungActionOffered && (
            <ListInDirectoryConfirm
              isOpen={confirmingRung}
              onClose={() => setConfirmingRung(false)}
              onConfirm={handleEnableRung}
              loading={rungPending}
              intro={t('spaces:settings.discovery.directory.adminOffSelfIntro')}
            />
          )}
          {flagsFailed && (
            // The switch is locked on a document that never arrived, so this
            // is the one line that says why and the only way back: the same
            // treatment the Streaming panel gives its own failed load, at the
            // scale of a reason under a switch.
            <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs flex flex-wrap items-center gap-2.5">
              <span>{t('common:states.loadSettingsFailed')}</span>
              <button
                type="button"
                onClick={retryFlags}
                disabled={flagsLoading}
                className="font-medium underline underline-offset-2 hover:no-underline transition-all disabled:no-underline disabled:opacity-60 disabled:cursor-default"
              >
                {t('common:actions.retry')}
              </button>
            </div>
          )}
          <p className="text-xs text-txt-tertiary">{t('spaces:settings.discovery.directory.disclosure')}</p>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('spaces:settings.discovery.description.label')}</div>
        <p className="text-xs text-txt-tertiary mb-2">{t('spaces:settings.discovery.description.hint')}</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX_LENGTH))}
            placeholder={t('spaces:settings.discovery.description.placeholder')}
            rows={3}
            className="input-standard w-full resize-none"
          />
          <div className="text-[11px] text-txt-tertiary text-right">
            {t('spaces:settings.discovery.description.counter', { length: description.length, max: DESCRIPTION_MAX_LENGTH })}
          </div>
        </div>
      </div>

      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {/* Pending Join Requests — only shown when visibility is 'request' */}
      {(visibility === 'request' || (space.visibility as SpaceVisibility) === 'request') && (
        <JoinRequestsSection spaceId={spaceId} />
      )}

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
    </div>
  );
}

function JoinRequestsSection({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(['spaces', 'common']);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const f = useFormatters();
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.explore.getJoinRequests(spaceId, 'pending')
      .then(({ requests: reqs }) => {
        if (!cancelled) {
          setRequests(reqs);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [spaceId]);

  const handleDecide = async (requestId: string, action: 'accept' | 'decline') => {
    setActionError('');
    try {
      await api.explore.decideJoinRequest(spaceId, requestId, action);
      setRequests(prev => prev.filter(r => r.id !== requestId));
    } catch (err) {
      setActionError(describeError(err));
    }
  };

  return (
    <div className="pt-4 border-t border-border-soft">
      <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-2">
        {t('spaces:settings.discovery.requests.title')}
      </div>

      {actionError && (
        <div className="mb-2 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-txt-tertiary">{t('common:states.loading')}</div>
      ) : requests.length === 0 ? (
        <div className="text-sm text-txt-tertiary">{t('spaces:settings.discovery.requests.empty')}</div>
      ) : (
        <div className="space-y-2 max-h-[240px] overflow-y-auto scrollbar-thin">
          {requests.map((req) => {
            const user = req.user;
            const displayName = user?.displayName ?? user?.username ?? t('common:states.unknown');

            return (
              <div key={req.id} className="flex items-start gap-3 p-2.5 rounded bg-surface-base">
                <Avatar
                  src={user?.avatar}
                  name={displayName}
                  size={32}
                  userId={user?.homeUserId ?? user?.id}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-txt-primary truncate">{displayName}</span>
                    {user?.username && (
                      <span className="text-xs text-txt-tertiary">@{user.username}</span>
                    )}
                  </div>
                  {req.message && (
                    <p className="text-xs text-txt-secondary mt-0.5 line-clamp-2">{req.message}</p>
                  )}
                  <span className="text-[10px] text-txt-tertiary">
                    {f.formatNumericDate(req.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleDecide(req.id, 'accept')}
                    className="p-1.5 rounded text-status-online hover:bg-status-online/20 transition-colors"
                    title={t('common:actions.accept')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDecide(req.id, 'decline')}
                    className="p-1.5 rounded text-txt-danger hover:bg-accent-rose/20 transition-colors"
                    title={t('common:actions.decline')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SpaceSettingsTab = 'overview' | 'discovery' | 'members' | 'roles' | 'bans';

const SPACE_SETTINGS_TABS: readonly SpaceSettingsTab[] = ['overview', 'discovery', 'members', 'roles', 'bans'];

function isSpaceSettingsTab(value: unknown): value is SpaceSettingsTab {
  return typeof value === 'string' && (SPACE_SETTINGS_TABS as readonly string[]).includes(value);
}

export function SpaceSettingsModal() {
  const { t } = useTranslation(['spaces', 'common']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const isMobile = useUIStore((s) => s.isMobile);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const [tab, setTab] = useState<SpaceSettingsTab>('overview');
  const [mobileView, setMobileView] = useState<'tabs' | 'content'>('tabs');

  const isOpen = activeModal === 'spaceSettings';
  const space = spaces.find(s => s.id === currentSpaceId);
  const mySpacePerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canManageSpace = hasPermissionBit(mySpacePerms, PermissionBits.MANAGE_SPACE);
  const canManageRoles = hasPermissionBit(mySpacePerms, PermissionBits.MANAGE_ROLES);
  const canBanMembers = hasPermissionBit(mySpacePerms, PermissionBits.BAN_MEMBERS);

  // Reset tab and mobile view when modal opens. A caller may name the tab
  // to open on (`openModal('spaceSettings', { tab: 'discovery' })`); a tab
  // this user cannot see falls back to the overview, and on mobile a named
  // tab opens straight on its content, as user settings does.
  const requestedTab = isOpen ? modalData.tab : undefined;
  useEffect(() => {
    if (!isOpen) return;
    const allowed: Record<SpaceSettingsTab, boolean> = {
      overview: true,
      discovery: canManageSpace,
      members: true,
      roles: canManageRoles,
      bans: canBanMembers,
    };
    const deepLinked = isSpaceSettingsTab(requestedTab) && allowed[requestedTab];
    setTab(deepLinked ? requestedTab : 'overview');
    setMobileView(deepLinked ? 'content' : 'tabs');
    // Only the opening decides the tab: a permission that changes while the
    // modal is open must not throw the user back to where they came in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, requestedTab]);

  if (!space || !currentSpaceId) return null;

  const tabClass = (target: typeof tab) =>
    `w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
      tab === target ? 'bg-interactive-selected text-txt-primary font-medium' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  const handleTabClick = (target: typeof tab) => {
    setTab(target);
    if (isMobile) setMobileView('content');
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} size="settings" mobileStyle="fullscreen">
      <div className="flex h-full">
        {/* Desktop Sidebar */}
        <div className="hidden desktop:flex w-52 flex-shrink-0 flex-col p-4 gap-3">
          {/* Space card */}
          <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
            <Avatar
              src={space.icon}
              name={space.name}
              size={36}
              userId={space.id}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-txt-primary truncate">{space.name}</div>
            </div>
          </div>

          {/* Nav list */}
          <div className="glass-bubble rounded-lg p-2 flex-1 flex flex-col">
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">{t('spaces:settings.nav.general')}</div>
            <button onClick={() => handleTabClick('overview')} className={tabClass('overview')}>{t('spaces:settings.nav.tabs.overview')}</button>
            {canManageSpace && (
              <button onClick={() => handleTabClick('discovery')} className={tabClass('discovery')}>{t('spaces:settings.nav.tabs.discovery')}</button>
            )}

            <div className="border-t border-white/[0.04] my-2 mx-2" />
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">{t('spaces:settings.nav.management')}</div>
            <button onClick={() => handleTabClick('members')} className={tabClass('members')}>{t('common:labels.members')}</button>
            {canManageRoles && (
              <button onClick={() => handleTabClick('roles')} className={tabClass('roles')}>{t('spaces:settings.nav.tabs.roles')}</button>
            )}
            {canBanMembers && (
              <button onClick={() => handleTabClick('bans')} className={tabClass('bans')}>{t('spaces:settings.nav.tabs.bans')}</button>
            )}
          </div>
        </div>

        {/* Mobile: Tab list */}
        {isMobile && mobileView === 'tabs' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Mobile space card */}
            <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
              <Avatar
                src={space.icon}
                name={space.name}
                size={36}
                userId={space.id}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary truncate">{space.name}</div>
              </div>
            </div>

            <div className="glass-bubble rounded-lg p-2 space-y-0.5">
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">{t('spaces:settings.nav.general')}</div>
              <button onClick={() => handleTabClick('overview')} className={tabClass('overview')}>{t('spaces:settings.nav.tabs.overview')}</button>
              {canManageSpace && (
                <button onClick={() => handleTabClick('discovery')} className={tabClass('discovery')}>{t('spaces:settings.nav.tabs.discovery')}</button>
              )}

              <div className="border-t border-white/[0.04] my-2 mx-2" />
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">{t('spaces:settings.nav.management')}</div>
              <button onClick={() => handleTabClick('members')} className={tabClass('members')}>{t('common:labels.members')}</button>
              {canManageRoles && (
                <button onClick={() => handleTabClick('roles')} className={tabClass('roles')}>{t('spaces:settings.nav.tabs.roles')}</button>
              )}
              {canBanMembers && (
                <button onClick={() => handleTabClick('bans')} className={tabClass('bans')}>{t('spaces:settings.nav.tabs.bans')}</button>
              )}
            </div>
          </div>
        )}

        {/* Content area (desktop always, mobile only when viewing content) */}
        {(!isMobile || mobileView === 'content') && (
          <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin py-6">
            <div className="px-6 max-w-[640px] mx-auto">
              {/* Mobile back button */}
              {isMobile && (
                <button
                  onClick={() => setMobileView('tabs')}
                  className="flex items-center gap-1.5 text-txt-tertiary hover:text-txt-secondary mb-4 text-sm"
                  aria-label={t('spaces:settings.backAria')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                  {t('spaces:settings.title')}
                </button>
              )}
              {tab === 'overview' && <OverviewPanel spaceId={currentSpaceId} />}
              {tab === 'discovery' && canManageSpace && <DiscoveryPanel spaceId={currentSpaceId} />}
              {tab === 'members' && <MembersPanel spaceId={currentSpaceId} />}
              {tab === 'roles' && canManageRoles && <RolesPanel spaceId={currentSpaceId} />}
              {tab === 'bans' && canBanMembers && <BansPanel spaceId={currentSpaceId} />}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
