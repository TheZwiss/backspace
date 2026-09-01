import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { api, HttpError } from '../../../api/client';
import { onFederationPeersChanged, onFederationPeerResetDetected } from '../../../hooks/useWebSocket';
import type { InstanceAdminSettings } from '@backspace/shared';
import type { FederationPeer, ApprovalRequest, FederationResetEvent, FederationOrphanedAccount } from '../../../api/client';
import { Trans } from 'react-i18next';
import { translate } from '../../../i18n';

// ─── Global Settings ─────────────────────────────────────────────────────────

function FederationGlobalSettings() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<Pick<InstanceAdminSettings, 'federationRelayEnabled' | 'federationRelayTtlDays' | 'defaultAutoRotateIntervalDays' | 'autoAcceptPeering'> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (instanceSettings) {
      setDraft({
        federationRelayEnabled: instanceSettings.federationRelayEnabled,
        federationRelayTtlDays: instanceSettings.federationRelayTtlDays,
        defaultAutoRotateIntervalDays: instanceSettings.defaultAutoRotateIntervalDays,
        autoAcceptPeering: instanceSettings.autoAcceptPeering,
      });
    }
  }, [instanceSettings]);

  if (!draft) return null;

  const hasChanges = instanceSettings
    ? draft.federationRelayEnabled !== instanceSettings.federationRelayEnabled ||
      draft.federationRelayTtlDays !== instanceSettings.federationRelayTtlDays ||
      draft.defaultAutoRotateIntervalDays !== instanceSettings.defaultAutoRotateIntervalDays ||
      draft.autoAcceptPeering !== instanceSettings.autoAcceptPeering
    : false;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateInstanceSettings(draft);
      addToast(translate('runtime.messages.FederationPanel.settingsSaved'), 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.failedToSave'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) {
      setDraft({
        federationRelayEnabled: instanceSettings.federationRelayEnabled,
        federationRelayTtlDays: instanceSettings.federationRelayTtlDays,
        defaultAutoRotateIntervalDays: instanceSettings.defaultAutoRotateIntervalDays,
        autoAcceptPeering: instanceSettings.autoAcceptPeering,
      });
    }
    setSaveError('');
  };

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5"><Trans i18nKey="ui.FederationPanel.relaySettings">Relay Settings</Trans></div>
      <p className="text-xs text-txt-tertiary mb-2">
        <Trans i18nKey="ui.FederationPanel.controlDMRelayBetweenFederatedInstancesWhenEnabled">Control DM relay between federated instances. When enabled, DMs with users on peer instances are relayed server-to-server.</Trans>
      </p>
      <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-sm font-medium text-txt-primary"><Trans i18nKey="ui.FederationPanel.enableDMRelay">Enable DM Relay</Trans></div>
            <div className="text-xs text-txt-tertiary mt-0.5"><Trans i18nKey="ui.FederationPanel.relayDirectMessagesToAndFromPeerInstances">Relay direct messages to and from peer instances</Trans></div>
          </div>
          <Toggle enabled={draft.federationRelayEnabled} onChange={(v) => setDraft({ ...draft, federationRelayEnabled: v })} />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-sm font-medium text-txt-primary"><Trans i18nKey="ui.FederationPanel.autoAcceptPeering">Auto-accept peering</Trans></div>
            <div className="text-xs text-txt-tertiary mt-0.5"><Trans i18nKey="ui.FederationPanel.automaticallyAcceptPeeringRequestsFromOtherInstancesWhen">Automatically accept peering requests from other instances. When disabled, only manually initiated peering is allowed.</Trans></div>
          </div>
          <Toggle enabled={draft.autoAcceptPeering} onChange={(v) => setDraft({ ...draft, autoAcceptPeering: v })} />
        </label>

        <div>
          <div className="text-sm font-medium text-txt-primary mb-1"><Trans i18nKey="ui.FederationPanel.relayTTLDays">Relay TTL (days)</Trans></div>
          <div className="text-xs text-txt-tertiary mb-2"><Trans i18nKey="ui.FederationPanel.howLongRelayedMessagesAreRetainedInThe">How long relayed messages are retained in the outbox before cleanup</Trans></div>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.federationRelayTtlDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 365) {
                setDraft({ ...draft, federationRelayTtlDays: val });
              }
            }}
            className="input-standard w-24"
          />
        </div>

        <div>
          <div className="text-sm font-medium text-txt-primary mb-1"><Trans i18nKey="ui.FederationPanel.defaultSecretRotationDays">Default Secret Rotation (days)</Trans></div>
          <div className="text-xs text-txt-tertiary mb-2"><Trans i18nKey="ui.FederationPanel.autoRotationIntervalForNewPeersExistingPeers">Auto-rotation interval for new peers. Existing peers keep their current setting.</Trans></div>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.defaultAutoRotateIntervalDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 365) {
                setDraft({ ...draft, defaultAutoRotateIntervalDays: val });
              }
            }}
            className="input-standard w-24"
          />
        </div>
      </div>

      {saveError && (
        <div className="mt-2 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}

      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button onClick={handleReset} className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors">
                <Trans i18nKey="ui.FederationPanel.reset">Reset</Trans>
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? translate('runtime.expressions.FederationPanel.saving') : translate('runtime.expressions.FederationPanel.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return translate('runtime.selected.FederationPanel.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAbsoluteDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function peerStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online/15 text-status-online';
    case 'pending': return 'bg-accent-lavender/15 text-accent-lavender';
    case 'unreachable': return 'bg-accent-amber/15 text-accent-amber';
    case 'rejected': return 'bg-accent-rose/15 text-accent-rose';
    case 'awaiting_approval': return 'bg-accent-amber/15 text-accent-amber';
    case 'needs_attention': return 'bg-accent-rose/15 text-accent-rose';
    case 'revoked': return 'bg-white/5 text-txt-tertiary';
    default: return 'bg-white/5 text-txt-tertiary';
  }
}

function peerStatusDotColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online';
    case 'pending': return 'bg-accent-lavender';
    case 'unreachable': return 'bg-accent-amber';
    case 'rejected': return 'bg-accent-rose';
    case 'awaiting_approval': return 'bg-accent-amber';
    case 'needs_attention': return 'bg-accent-rose';
    default: return 'bg-txt-tertiary';
  }
}

function peerStatusLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active';
    case 'pending': return 'Pending';
    case 'unreachable': return 'Unreachable';
    case 'rejected': return 'Rejected (auto-peering denied)';
    case 'revoked': return 'Revoked';
    case 'awaiting_approval': return translate('runtime.selected.FederationPanel.awaitingApproval');
    case 'needs_attention': return translate('runtime.selected.FederationPanel.needsAttention');
    default: return status;
  }
}

type PeerView = 'active' | 'revoked';
type SortBy = 'name' | 'lastSeen' | 'dateAdded' | 'failures';
type StatusFilter = 'active' | 'unreachable' | 'pending' | 'rejected' | 'awaiting_approval' | 'needs_attention';

// ─── Filter Dropdown ─────────────────────────────────────────────────────────

function FilterDropdown({
  view,
  statusFilter,
  setStatusFilter,
  sortBy,
  setSortBy,
}: {
  view: PeerView;
  statusFilter: Set<StatusFilter>;
  setStatusFilter: (f: Set<StatusFilter>) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggleStatus = (s: StatusFilter) => {
    const next = new Set(statusFilter);
    if (next.has(s)) {
      if (next.size > 1) next.delete(s);
    } else {
      next.add(s);
    }
    setStatusFilter(next);
  };

  const sortOptions: Array<{ key: SortBy; label: string }> = view === 'active'
    ? [
        { key: 'name', label: translate('runtime.properties.FederationPanel.nameAZ') },
        { key: 'lastSeen', label: translate('runtime.properties.FederationPanel.lastSeen') },
        { key: 'dateAdded', label: translate('runtime.properties.FederationPanel.dateAdded') },
        { key: 'failures', label: translate('runtime.properties.FederationPanel.failures') },
      ]
    : [
        { key: 'name', label: translate('runtime.properties.FederationPanel.nameAZ2') },
        { key: 'dateAdded', label: translate('runtime.properties.FederationPanel.revokedDate') },
      ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-txt-tertiary hover:text-txt-secondary bg-white/[0.04] hover:bg-white/[0.06] rounded transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="opacity-60">
          <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <Trans i18nKey="ui.FederationPanel.filter">Filter</Trans>
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 glass rounded-lg p-1.5 w-48">
            {view === "active" && (
              <>
                <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1"><Trans i18nKey="ui.FederationPanel.status">Status</Trans></div>
                {(["active", "unreachable", "pending", "rejected", 'awaiting_approval', 'needs_attention'] as StatusFilter[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded ${
                      statusFilter.has(s) ? 'text-txt-primary bg-white/[0.04]' : 'text-txt-tertiary'
                    } hover:bg-white/[0.06] transition-colors`}
                  >
                    <div className={`w-2 h-2 rounded-full ${peerStatusDotColor(s)}`} />
                    <span className="capitalize">
                      {s === 'awaiting_approval' ? translate('runtime.expressions.FederationPanel.awaitingApproval')
                        : s === 'needs_attention' ? translate('runtime.expressions.FederationPanel.needsAttention')
                        : s}
                    </span>
                  </button>
                ))}
                <div className="h-px bg-white/[0.06] my-1" />
              </>
            )}
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1"><Trans i18nKey="ui.FederationPanel.sortBy">Sort by</Trans></div>
            {sortOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => { setSortBy(opt.key); setOpen(false); }}
                className={`w-full text-left px-2 py-1.5 text-xs rounded ${
                  sortBy === opt.key ? 'text-accent-lavender bg-accent-lavender/[0.08]' : 'text-txt-primary'
                } hover:bg-white/[0.06] transition-colors`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Peer List Controls ──────────────────────────────────────────────────────

function PeerListControls({
  view,
  setView,
  activeCount,
  revokedCount,
  statusFilter,
  setStatusFilter,
  sortBy,
  setSortBy,
}: {
  view: PeerView;
  setView: (v: PeerView) => void;
  activeCount: number;
  revokedCount: number;
  statusFilter: Set<StatusFilter>;
  setStatusFilter: (f: Set<StatusFilter>) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex bg-white/[0.04] rounded-md p-0.5">
        <button
          type="button"
          onClick={() => setView('active')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            view === 'active' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          <Trans i18nKey="ui.FederationPanel.active">Active</Trans> <span className="text-[10px] text-txt-tertiary ml-0.5">{activeCount}</span>
        </button>
        <button
          type="button"
          onClick={() => setView('revoked')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            view === 'revoked' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          <Trans i18nKey="ui.FederationPanel.revoked">Revoked</Trans> <span className="text-[10px] text-txt-tertiary ml-0.5">{revokedCount}</span>
        </button>
      </div>
      <FilterDropdown
        view={view}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        sortBy={sortBy}
        setSortBy={setSortBy}
      />
    </div>
  );
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

function sortPeers(peers: FederationPeer[], sortBy: SortBy, view: PeerView): FederationPeer[] {
  return [...peers].sort((a, b) => {
    switch (sortBy) {
      case 'name': {
        const nameA = (a.instanceName || new URL(a.origin).host).toLowerCase();
        const nameB = (b.instanceName || new URL(b.origin).host).toLowerCase();
        return nameA.localeCompare(nameB);
      }
      case 'lastSeen':
        return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      case 'dateAdded':
        return b.createdAt - a.createdAt;
      case 'failures':
        return (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0);
      default:
        return 0;
    }
  });
}

// ─── Peer Row ────────────────────────────────────────────────────────────────

function PeerRow({ peer, view, expanded, onToggleExpand, onAction, onRecheck, recheckLoading, defaultAutoRotateIntervalDays }: {
  peer: FederationPeer;
  view: PeerView;
  expanded: boolean;
  onToggleExpand: () => void;
  onAction: (type: 'rotate' | 'revoke' | 'reinitiate' | 'delete' | 'reset') => void;
  onRecheck: () => void;
  recheckLoading: boolean;
  defaultAutoRotateIntervalDays: number;
}) {
  const [editingInterval, setEditingInterval] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState(peer.autoRotateIntervalDays);
  const [intervalSaving, setIntervalSaving] = useState(false);
  const [intervalError, setIntervalError] = useState('');
  const addToast = useUIStore((s) => s.addToast);

  const name = peer.instanceName || new URL(peer.origin).host;
  const isRevoked = view === 'revoked' || peer.status === 'rejected';
  const isDefault = peer.autoRotateIntervalDays === defaultAutoRotateIntervalDays;

  const handleSaveInterval = async () => {
    if (intervalDraft < 1 || intervalDraft > 365) {
      setIntervalError(translate('runtime.messages.FederationPanel.mustBe1365'));
      return;
    }
    setIntervalSaving(true);
    setIntervalError('');
    try {
      const result = await api.federation.updatePeer(peer.id, { autoRotateIntervalDays: intervalDraft });
      // Update peer in parent state via a re-fetch would be cleanest,
      // but for responsiveness we update the peer object directly.
      // This works because React re-renders from the parent's setPeers.
      peer.autoRotateIntervalDays = result.peer.autoRotateIntervalDays;
      setEditingInterval(false);
      addToast(translate('runtime.messages.FederationPanel.rotationIntervalUpdated'), 'success', 2000);
    } catch (err) {
      setIntervalError(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.failedToUpdate'));
    } finally {
      setIntervalSaving(false);
    }
  };

  return (
    <div className={`bg-white/[0.02] rounded-md transition-colors ${isRevoked ? 'opacity-70' : ''} ${expanded ? 'border border-white/[0.06]' : ''}`}>
      {/* Compact row */}
      <div
        className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-white/[0.02] rounded-md"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isRevoked ? 'bg-txt-tertiary' : peerStatusDotColor(peer.status)}`} />
          <div className="min-w-0">
            <div className={`text-sm font-medium truncate ${isRevoked ? 'text-txt-tertiary line-through' : 'text-txt-primary'}`}>
              {name}
            </div>
            <div className="text-[11px] text-txt-tertiary truncate">
              {isRevoked
                ? `Revoked: ${formatAbsoluteDate(peer.lastSeenAt ?? peer.createdAt)} · Peered: ${formatAbsoluteDate(peer.createdAt)}`
                : peer.status === "unreachable"
                  ? `Last seen: ${formatRelativeTime(peer.lastSeenAt)} · ${peer.consecutiveFailures ?? 0} failures`
                  : `Last seen: ${formatRelativeTime(peer.lastSeenAt)} · Synced: ${formatRelativeTime(peer.lastSyncedAt)}`
              }
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${peerStatusColor(peer.status)}`}>
            {peerStatusLabel(peer.status)}
          </span>
          <span className="text-txt-tertiary text-xs">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3">
          <div className="border-t border-white/[0.05] pt-3">
            {isRevoked ? (
              /* Revoked peer actions */
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAction("reinitiate"); }}
                  className="px-3 py-1.5 text-xs font-medium bg-status-online/10 text-status-online hover:bg-status-online/20 rounded transition-colors"
                >
                  <Trans i18nKey="ui.FederationPanel.reInitiatePeering">Re-initiate Peering</Trans>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAction("delete"); }}
                  className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                >
                  <Trans i18nKey="ui.FederationPanel.deletePermanently">Delete Permanently</Trans>
                </button>
              </div>
            ) : (
              <>
                {/* Stats grid */}
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.consecutiveFailures">Consecutive Failures</Trans></div>
                    <div className={`text-xs ${(peer.consecutiveFailures ?? 0) > 0 ? 'text-accent-amber font-medium' : 'text-txt-secondary'}`}>
                      {peer.consecutiveFailures ?? 0}
                    </div>
                  </div>
                  {peer.status === 'needs_attention' && (
                    <div>
                      <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.authFailures">Auth Failures</Trans></div>
                      <div className="text-xs text-accent-rose font-medium">
                        {peer.consecutiveAuthFailures}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.lastFailure">Last Failure</Trans></div>
                    <div className="text-xs text-txt-secondary">{formatRelativeTime(peer.lastFailureAt)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.peeredSince">Peered Since</Trans></div>
                    <div className="text-xs text-txt-secondary">{formatAbsoluteDate(peer.createdAt)}</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.secretRotated">Secret Rotated</Trans></div>
                    <div className="text-xs text-txt-secondary">{formatRelativeTime(peer.secretRotatedAt)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.autoRotate">Auto-Rotate</Trans></div>
                    {editingInterval ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={intervalDraft}
                          onChange={(e) => setIntervalDraft(parseInt(e.target.value, 10) || 0)}
                          className="input-standard w-16 py-0.5 text-xs"
                          disabled={intervalSaving}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={handleSaveInterval}
                          disabled={intervalSaving}
                          className="text-[10px] text-accent-primary hover:text-accent-primary/80 disabled:opacity-50"
                        >
                          {intervalSaving ? '...' : translate('runtime.expressions.FederationPanel.save2')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingInterval(false); setIntervalDraft(peer.autoRotateIntervalDays); setIntervalError(''); }}
                          className="text-[10px] text-txt-tertiary hover:text-txt-secondary"
                        >
                          <Trans i18nKey="ui.FederationPanel.cancel">Cancel</Trans>
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs text-txt-secondary">
                        <Trans i18nKey="ui.FederationPanel.every">Every</Trans> {peer.autoRotateIntervalDays}d
                        {isDefault && <span className="text-[10px] text-txt-tertiary ml-1"><Trans i18nKey="ui.FederationPanel.default">(default)</Trans></span>}
                      </div>
                    )}
                    {intervalError && <div className="text-[10px] text-txt-danger mt-0.5">{intervalError}</div>}
                  </div>
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5"><Trans i18nKey="ui.FederationPanel.rotationStatus">Rotation Status</Trans></div>
                    <div className="text-xs text-txt-secondary">
                      {peer.rotationInProgress ? translate('runtime.expressions.FederationPanel.inProgress') : translate('runtime.expressions.FederationPanel.idle')}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  {peer.status === "unreachable" && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRecheck(); }}
                      disabled={recheckLoading}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-mint/10 text-accent-mint hover:bg-accent-mint/20 rounded transition-colors disabled:opacity-50"
                    >
                      {recheckLoading ? translate('runtime.expressions.FederationPanel.checking') : translate('runtime.expressions.FederationPanel.checkNow')}
                    </button>
                  )}
                  {peer.status === 'needs_attention' ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onAction("reset"); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                    >
                      <Trans i18nKey="ui.FederationPanel.resetPeering">Reset Peering</Trans>
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onAction("rotate"); }}
                        disabled={peer.rotationInProgress}
                        className="px-3 py-1.5 text-xs font-medium bg-accent-lavender/10 text-accent-lavender hover:bg-accent-lavender/20 rounded transition-colors disabled:opacity-50"
                        title={peer.rotationInProgress ? translate('runtime.expressions.FederationPanel.rotationAlreadyInProgress') : undefined}
                      >
                        <Trans i18nKey="ui.FederationPanel.rotateSecret">Rotate Secret</Trans>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onAction("revoke"); }}
                        className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                      >
                        <Trans i18nKey="ui.FederationPanel.revoke">Revoke</Trans>
                      </button>
                      {!editingInterval && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setEditingInterval(true); setIntervalDraft(peer.autoRotateIntervalDays); }}
                          className="text-[11px] text-txt-tertiary hover:text-txt-secondary underline decoration-dotted transition-colors ml-1"
                        >
                          <Trans i18nKey="ui.FederationPanel.editRotationInterval">Edit rotation interval</Trans>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pending Approvals ──────────────────────────────────────────────────────

function PendingApprovals({ onCountChange }: { onCountChange?: (count: number) => void }) {
  const addToast = useUIStore((s) => s.addToast);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'approve' | 'deny';
    request: ApprovalRequest;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.federation.approvalRequests();
      setRequests(result.requests);
      onCountChange?.(result.requests.length);
    } catch {
      // Silently fail — empty list shown
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Real-time updates: re-fetch approval requests on federation changes
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const unsub = onFederationPeersChanged(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        fetchRequests();
      }, 500);
    });
    return () => { unsub(); clearTimeout(timeout); };
  }, [fetchRequests]);

  const handleConfirm = async () => {
    if (!confirmAction) return;
    const { type, request: req } = confirmAction;
    setActionLoading(req.id);
    setErrors((prev) => { const next = { ...prev }; delete next[req.id]; return next; });

    try {
      if (type === 'approve') {
        await api.federation.approveRequest(req.id);
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        onCountChange?.(requests.length - 1);
        addToast(translate('runtime.templates.FederationPanel.peeringEstablishedWith', { p0: req.instanceName || req.origin }), 'success', 3000);
      } else {
        await api.federation.denyRequest(req.id);
        setRequests((prev) => prev.filter((r) => r.id !== req.id));
        onCountChange?.(requests.length - 1);
        addToast(translate('runtime.templates.FederationPanel.deniedPeeringRequestFrom', { p0: req.instanceName || req.origin }), 'success', 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : translate('runtime.selected.FederationPanel.actionFailed');
      setErrors((prev) => ({ ...prev, [req.id]: msg }));
    } finally {
      setActionLoading(null);
      setConfirmAction(null);
    }
  };

  if (requests.length === 0 && !loading) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider"><Trans i18nKey="ui.FederationPanel.pendingApprovalRequests">Pending Approval Requests</Trans></div>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-amber/15 text-accent-amber">
          {requests.length}
        </span>
      </div>
      <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2 mb-5">
        {loading && requests.length === 0 && (
          <div className="text-xs text-txt-tertiary py-2"><Trans i18nKey="ui.FederationPanel.loading">Loading...</Trans></div>
        )}
        {requests.map((req) => {
          const isOutbound = req.direction === "outbound";
          let name = req.instanceName || '';
          if (!name) {
            try {
              name = new URL(req.origin).host;
            } catch {
              name = req.origin;
            }
          }
          const subCount = req.subscribers?.length ?? 0;
          const titleText = isOutbound
            ? `${name} — ${subCount} ${subCount === 1 ? "user wants" : "users want"} us to peer`
            : name;
          return (
            <div key={req.id} className="bg-white/[0.02] rounded-md px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-txt-primary truncate">{titleText}</div>
                  <div className="text-[11px] text-txt-tertiary truncate">{req.origin}</div>
                  <div className="text-[11px] text-txt-tertiary mt-0.5">
                    <Trans i18nKey="ui.FederationPanel.requested">Requested</Trans> {formatRelativeTime(req.requestedAt)}
                  </div>
                  {isOutbound && req.subscribers && req.subscribers.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {req.subscribers.map((sub) => (
                        <div
                          key={`${sub.userId}:${sub.triggerReason}:${sub.triggerTarget}`}
                          className="text-[11px] text-txt-tertiary"
                        >
                          <span className="font-medium text-txt-secondary">{sub.username}</span>
                          {' — '}
                          {sub.triggerReason === 'friend_add' && `friend-add to ${sub.triggerTarget}`}
                          {sub.triggerReason === 'space_join' && `wants to join ${sub.triggerTarget}`}
                          {sub.triggerReason === 'direct_message' && `wants to DM ${sub.triggerTarget}`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <button
                    type="button"
                    onClick={() => setConfirmAction({ type: "approve", request: req })}
                    disabled={actionLoading === req.id}
                    className="px-3 py-1.5 text-xs font-medium bg-status-online/10 text-status-online hover:bg-status-online/20 rounded transition-colors disabled:opacity-50"
                  >
                    <Trans i18nKey="ui.FederationPanel.approve">Approve</Trans>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAction({ type: "deny", request: req })}
                    disabled={actionLoading === req.id}
                    className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors disabled:opacity-50"
                  >
                    <Trans i18nKey="ui.FederationPanel.deny">Deny</Trans>
                  </button>
                </div>
              </div>
              {errors[req.id] && (
                <div className="mt-2 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-[11px]">
                  {errors[req.id]}
                  <button
                    type="button"
                    onClick={() => setErrors((prev) => { const next = { ...prev }; delete next[req.id]; return next; })}
                    className="ml-2 underline"
                  >
                    <Trans i18nKey="ui.FederationPanel.dismiss">Dismiss</Trans>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmAction && (() => {
        const isOutbound = confirmAction.request.direction === "outbound";
        const targetName = confirmAction.request.instanceName || confirmAction.request.origin;
        const subCount = confirmAction.request.subscribers?.length ?? 0;
        const description =
          confirmAction.type === "approve"
            ? isOutbound
              ? translate('runtime.templates.FederationPanel.thisWillInitiateAPeeringHandshakeWithOn', { p0: targetName, p1: subCount, p2: translate('runtime.manual.requestingUser', { count: subCount }) })
              : translate('runtime.templates.FederationPanel.thisWillInitiateAPeeringHandshakeWithThe', { p0: targetName })
            : isOutbound
              ? translate('runtime.templates.FederationPanel.thisWillDenyTheOutboundPeeringRequestAnd', { p0: subCount === 1 ? "user" : "users" })
              : translate('runtime.templates.FederationPanel.thisWillDenyTheRequestAndBlockFuture', { p0: targetName });
        const confirmLabel =
          confirmAction.type === "approve"
            ? isOutbound ? "Approve & Peer" : "Approve"
            : isOutbound ? "Deny & Notify" : "Deny";
        return (
          <ConfirmDialog
            isOpen={true}
            onClose={() => { if (!actionLoading) setConfirmAction(null); }}
            onConfirm={handleConfirm}
            title={confirmAction.type === "approve" ? translate('runtime.expressions.FederationPanel.approvePeeringRequest') : translate('runtime.expressions.FederationPanel.denyPeeringRequest')}
            description={description}
            confirmLabel={confirmLabel}
            variant={confirmAction.type === "approve" ? "warning" : "danger"}
            loading={!!actionLoading}
          />
        );
      })()}
    </div>
  );
}

// ─── Reset Cleanup ──────────────────────────────────────────────────────────
//
// Admin attention surface for the instance-epoch self-healing flow (§6.4) and
// the orphaned-account detach flow (detach spec §4.6). Two stacked surfaces:
//   1. A persistent accent-rose banner per peer detected as reset
//      (status === 'needs_attention' && needsAttentionReason === 'peer_reset_detected'),
//      with a one-click Re-peer (resetPeer → initiatePeering) that triggers the
//      server-side heal on activation. This one is genuinely actionable, so it
//      keeps the rose/danger styling.
//   2. Per-origin, informational cards for the dead incarnation's detached real
//      accounts. Detachment is not a failure state: these accounts keep working
//      locally and their owners sign in with the same password. The card offers a
//      real, server-side Dismiss (acknowledgeResetEvent — hides the card without
//      touching the accounts) and a per-account Remove (full purge via the existing
//      admin delete) for the ones that truly are abandoned. Neutral tier styling —
//      no urgency. Acknowledged events are filtered out client-side (the endpoint
//      keeps returning them for audit).

function peerName(peer: FederationPeer): string {
  if (peer.instanceName) return peer.instanceName;
  try {
    return new URL(peer.origin).host;
  } catch {
    return peer.origin;
  }
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

type ResetConfirmAction =
  | { kind: 'repeer'; peer: FederationPeer }
  | { kind: 'remove'; account: FederationOrphanedAccount; origin: string };

function ResetCleanup() {
  const addToast = useUIStore((s) => s.addToast);
  const [resetPeers, setResetPeers] = useState<FederationPeer[]>([]);
  const [events, setEvents] = useState<FederationResetEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ResetConfirmAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [peersResult, eventsResult] = await Promise.all([
        api.federation.peers(),
        api.federation.resetEvents(),
      ]);
      setResetPeers(
        peersResult.peers.filter(
          (p) => p.status === 'needs_attention' && p.needsAttentionReason === 'peer_reset_detected',
        ),
      );
      setEvents(eventsResult.events);
    } catch {
      // Silently fail — empty surface shown; the peer list section surfaces load errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Real-time: re-fetch (debounced) on any federation change.
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const unsub = onFederationPeersChanged(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        fetchAll();
      }, 500);
    });
    return () => { unsub(); clearTimeout(timeout); };
  }, [fetchAll]);

  // Real-time: a fresh reset detection nudges the admin (the banner is the real
  // surface) and triggers an immediate re-fetch.
  useEffect(() => {
    const unsub = onFederationPeerResetDetected((origin) => {
      addToast(`${originHost(origin)} was reset — federation needs re-establishing`, 'warning');
      fetchAll();
    });
    return () => { unsub(); };
  }, [addToast, fetchAll]);

  const handleConfirm = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      if (confirmAction.kind === 'repeer') {
        const { peer } = confirmAction;
        // Order matters: reset the stale local record BEFORE the fresh handshake,
        // so activation heals stale friendships/DMs against the new incarnation.
        await api.federation.resetPeer(peer.id);
        const result = await api.federation.initiatePeering({ remoteOrigin: peer.origin });
        if (result.verified === false || result.peer?.status === 'needs_attention') {
          addToast(
            `Re-peer incomplete — ${peerName(peer)} still holds stale peering for you. Its admin must reset their side, then Re-peer again.`,
            'warning',
          );
        } else {
          addToast(`Re-peering initiated with ${peerName(peer)}`, 'success', 3000);
        }
        await fetchAll();
      } else {
        const { account } = confirmAction;
        await api.admin.deleteUser(account.id);
        addToast(translate('runtime.templates.FederationPanel.removedAndAllTheirContent', { p0: account.username }), 'success', 3000);
        await fetchAll();
      }
    } catch (err) {
      if (confirmAction.kind === 'remove') {
        const ownsSpaces =
          err instanceof HttpError &&
          err.status === 400 &&
          Array.isArray((err.body as { ownedSpaces?: unknown } | undefined)?.ownedSpaces);
        if (ownsSpaces) {
          addToast(
            `${confirmAction.account.username} owns spaces — transfer ownership first (Space Settings → Ownership).`,
            'warning',
          );
        } else {
          addToast(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.failedToRemoveAccount'), 'warning');
        }
      } else if (
        err instanceof HttpError && err.status === 409 &&
        (err.body as { code?: string } | undefined)?.code === 'PEER_EXISTS_RESET_REQUIRED'
      ) {
        addToast(
          translate('runtime.manual.remoteStillHoldsStalePeering'),
          'warning',
        );
      } else {
        addToast(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.rePeeringFailed'), 'warning');
      }
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  };

  // Dismiss the detached-accounts card without touching the accounts — the event
  // stays in the DB (acknowledged) for audit but stops surfacing to the admin.
  const handleDismiss = async (origin: string) => {
    setActionLoading(true);
    try {
      await api.federation.acknowledgeResetEvent(origin);
      await fetchAll();
    } catch (err) {
      addToast(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.failedToDismiss'), 'warning');
    } finally {
      setActionLoading(false);
    }
  };

  // Only unacknowledged events with detached accounts surface a card. Dismissed
  // (acknowledged) events are filtered out here and drop off the badge count.
  const eventsWithOrphans = events.filter(
    (e) => e.orphanedAccounts.length > 0 && e.acknowledgedAt === null,
  );

  // Render nothing when there is no reset-detected peer and no orphaned account —
  // exactly as PendingApprovals returns null when empty (loading also renders null).
  if (resetPeers.length === 0 && eventsWithOrphans.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider"><Trans i18nKey="ui.FederationPanel.resetCleanup">Reset Cleanup</Trans></div>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent-rose/15 text-accent-rose">
          {resetPeers.length + eventsWithOrphans.length}
        </span>
      </div>

      {/* Reset-detected peer banners */}
      {resetPeers.length > 0 && (
        <div className="space-y-2 mb-3">
          {resetPeers.map((peer) => (
            <div
              key={peer.id}
              className="bg-accent-rose/10 border border-accent-rose/30 rounded-lg p-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-txt-primary">
                    {peerName(peer)} <Trans i18nKey="ui.FederationPanel.wasReset">was reset</Trans>
                  </div>
                  <div className="text-[11px] text-txt-tertiary truncate">{peer.origin}</div>
                  <p className="text-xs text-txt-secondary mt-1.5 leading-relaxed">
                    <Trans i18nKey="ui.FederationPanel.aNewInstanceIsRunningOnThisDomain">A new instance is running on this domain. Re-establish federation to heal stale friendships and DMs.</Trans>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmAction({ kind: "repeer", peer })}
                  disabled={actionLoading}
                  className="shrink-0 px-3 py-1.5 text-xs font-medium bg-accent-mint/10 text-accent-mint hover:bg-accent-mint/20 rounded transition-colors disabled:opacity-50"
                >
                  <Trans i18nKey="ui.FederationPanel.rePeer">Re-peer</Trans>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Orphaned real accounts per reset origin */}
      {eventsWithOrphans.length > 0 && (
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4 mb-5">
          {eventsWithOrphans.map((event) => (
            <div key={`${event.origin}:${event.deadEpoch}`}>
              <div className="text-xs text-txt-tertiary mb-2 leading-relaxed">
                <span className="font-medium text-txt-secondary">{originHost(event.origin)}</span>{' '}
                <Trans i18nKey="ui.FederationPanel.wasReset2">was reset —</Trans> {event.stubCount} <Trans i18nKey="ui.FederationPanel.replicated">replicated</Trans>{' '}
                {event.stubCount === 1 ? translate('runtime.expressions.FederationPanel.identity') : translate('runtime.expressions.FederationPanel.identities')} <Trans i18nKey="ui.FederationPanel.autoCleaned">auto-cleaned,</Trans>{' '}
                {event.orphanedAccounts.length}{' '}
                {event.orphanedAccounts.length === 1 ? translate('runtime.expressions.FederationPanel.account') : translate('runtime.expressions.FederationPanel.accounts')} <Trans i18nKey="ui.FederationPanel.withLocalContentDetachedDetachedAccountsKeepWorking">with local content detached.
                Detached accounts keep working locally — owners keep access with their existing password.
                The owner can re-attach a detached account to their new home identity from that account's
                settings (Account → detached notice) when logged into both.</Trans>
              </div>
              <div className="space-y-2">
                {event.orphanedAccounts.map((account) => (
                  <div key={account.id} className="bg-white/[0.02] rounded-md px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-txt-primary truncate">
                          {account.displayName || account.username}
                        </div>
                        <div className="text-[11px] text-txt-tertiary truncate">{account.username}</div>
                        <div className="text-[11px] text-txt-tertiary mt-0.5">
                          {account.spaceMemberCount}{' '}
                          {account.spaceMemberCount === 1 ? translate('runtime.expressions.FederationPanel.membership') : translate('runtime.expressions.FederationPanel.memberships')} ·{' '}
                          {account.messageCount}{' '}
                          {account.messageCount === 1 ? translate('runtime.expressions.FederationPanel.message') : translate('runtime.expressions.FederationPanel.messages')}
                        </div>
                        {account.ownedSpaces.length > 0 && (
                          <div className="text-[11px] text-accent-amber mt-0.5 truncate">
                            <Trans i18nKey="ui.FederationPanel.owns">Owns:</Trans> {account.ownedSpaces.map((s) => s.name).join(', ')}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({ kind: "remove", account, origin: event.origin })
                          }
                          disabled={actionLoading}
                          className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors disabled:opacity-50"
                        >
                          <Trans i18nKey="ui.FederationPanel.remove">Remove</Trans>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => handleDismiss(event.origin)}
                disabled={actionLoading}
                className="mt-2 px-3 py-1.5 text-xs font-medium text-txt-tertiary hover:text-txt-secondary bg-white/[0.04] hover:bg-white/[0.06] rounded transition-colors disabled:opacity-50"
              >
                <Trans i18nKey="ui.FederationPanel.dismissKeepAllDetachedAccounts">Dismiss — keep all detached accounts</Trans>
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => { if (!actionLoading) setConfirmAction(null); }}
          onConfirm={handleConfirm}
          title={confirmAction.kind === "repeer" ? translate('runtime.expressions.FederationPanel.reEstablishFederation') : translate('runtime.expressions.FederationPanel.removeDetachedAccount')}
          description={
            confirmAction.kind === "repeer"
              ? translate('runtime.templates.FederationPanel.thisDeletesTheLocalPeerRecordAndStarts', { p0: confirmAction.peer.origin })
              : translate('runtime.templates.FederationPanel.permanentlyDeleteAndAllTheirContentOnThis', { p0: confirmAction.account.username })
          }
          confirmLabel={confirmAction.kind === "repeer" ? translate('runtime.expressions.FederationPanel.rePeerHeal') : translate('runtime.expressions.FederationPanel.deletePermanently')}
          variant={confirmAction.kind === "repeer" ? "warning" : "danger"}
          loading={actionLoading}
        />
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function FederationPanel({ onApprovalCountChange }: { onApprovalCountChange?: (count: number) => void }) {
  const addToast = useUIStore((s) => s.addToast);

  const [approvalCount, setApprovalCount] = useState(0);

  const handleApprovalCountChange = useCallback((count: number) => {
    setApprovalCount(count);
    onApprovalCountChange?.(count);
  }, [onApprovalCountChange]);

  // Peer list state
  const [peers, setPeers] = useState<FederationPeer[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState('');
  const [view, setView] = useState<PeerView>('active');
  const [statusFilter, setStatusFilter] = useState<Set<StatusFilter>>(
    new Set(['active', 'unreachable', 'pending', 'rejected', 'awaiting_approval', 'needs_attention']),
  );
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [expandedPeerId, setExpandedPeerId] = useState<string | null>(null);

  // Confirm dialog state (used in Task 10)
  const [confirmAction, setConfirmAction] = useState<{
    type: 'rotate' | 'revoke' | 'reinitiate' | 'delete' | 'reset';
    peer: FederationPeer;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);

  const fetchPeers = useCallback(async () => {
    setPeersLoading(true);
    setPeersError('');
    try {
      const result = await api.federation.peers();
      setPeers(result.peers);
    } catch (err) {
      setPeersError(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.failedToLoadPeers'));
    } finally {
      setPeersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeers();
  }, [fetchPeers]);

  // Real-time updates: re-fetch peers and approval requests on any federation change
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const unsub = onFederationPeersChanged(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        fetchPeers();
      }, 500);
    });
    return () => { unsub(); clearTimeout(timeout); };
  }, [fetchPeers]);

  // Derived peer lists
  const activePeers = peers.filter((p) => p.status !== 'revoked');
  const revokedPeers = peers.filter((p) => p.status === 'revoked');

  const filteredPeers = view === 'active'
    ? activePeers.filter((p) => statusFilter.has(p.status as StatusFilter))
    : revokedPeers;

  const sortedPeers = sortPeers(filteredPeers, sortBy, view);

  // Empty state message
  const emptyMessage = peers.length === 0
    ? translate('runtime.selected.FederationPanel.noFederationPeersConfiguredPeersAreCreatedAutomatically')
    : view === 'active' && filteredPeers.length === 0
      ? translate('runtime.selected.FederationPanel.noPeersMatchTheCurrentFilter')
      : view === 'revoked' && revokedPeers.length === 0
        ? translate('runtime.selected.FederationPanel.noRevokedPeers')
        : null;

  const handleRecheck = async (peer: FederationPeer) => {
    setRecheckingId(peer.id);
    try {
      const result = await api.federation.recheckPeer(peer.id);
      const name = peer.instanceName || new URL(peer.origin).host;
      if (result.recovered) {
        setPeers((prev) => prev.map((p) =>
          p.id === peer.id ? { ...p, status: 'active' } : p
        ));
        addToast(translate('runtime.templates.FederationPanel.isBackOnline', { p0: name }), 'success', 3000);
      } else {
        addToast(translate('runtime.templates.FederationPanel.isStillUnreachable', { p0: name }), 'warning', 3000);
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.recheckFailed'), 'warning', 3000);
    } finally {
      setRecheckingId(null);
    }
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    const { type, peer } = confirmAction;
    setActionLoading(true);

    try {
      switch (type) {
        case 'rotate': {
          await api.federation.rotatePeerSecret(peer.id);
          setPeers((prev) => prev.map((p) =>
            p.id === peer.id ? { ...p, rotationInProgress: true } : p
          ));
          addToast(translate('runtime.messages.FederationPanel.secretRotationInitiated15MinuteGracePeriod'), 'success', 3000);
          break;
        }
        case 'revoke': {
          await api.federation.revokePeer(peer.id);
          setPeers((prev) => prev.map((p) =>
            p.id === peer.id ? { ...p, status: 'revoked' } : p
          ));
          addToast(translate('runtime.messages.FederationPanel.peerRevoked'), 'success', 2000);
          break;
        }
        case 'reinitiate': {
          const origin = peer.origin;
          await api.federation.deletePeerPermanently(peer.id);
          setPeers((prev) => prev.filter((p) => p.id !== peer.id));
          try {
            const result = await api.federation.initiatePeering({ remoteOrigin: origin });
            setPeers((prev) => [...prev, result.peer]);
            addToast(translate('runtime.messages.FederationPanel.peeringReInitiated'), 'success', 2000);
          } catch (err) {
            addToast(
              translate('runtime.templates.FederationPanel.peerRecordDeletedButHandshakeFailedRePeer', { p0: (err as Error).message, p1: origin }),
              'warning',
              5000,
            );
          }
          break;
        }
        case 'delete': {
          await api.federation.deletePeerPermanently(peer.id);
          setPeers((prev) => prev.filter((p) => p.id !== peer.id));
          addToast(translate('runtime.messages.FederationPanel.peerPermanentlyDeleted'), 'success', 2000);
          break;
        }
        case 'reset': {
          await api.federation.resetPeer(peer.id);
          setPeers((prev) => prev.filter((p) => p.id !== peer.id));
          addToast(translate('runtime.templates.FederationPanel.peeringResetFor', { p0: peer.instanceName || peer.origin }), 'success', 3000);
          break;
        }
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : translate('runtime.messages.FederationPanel.actionFailed'), 'warning', 3000);
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  };

  const confirmDialogProps = confirmAction ? (() => {
    const name = confirmAction.peer.instanceName || new URL(confirmAction.peer.origin).host;
    switch (confirmAction.type) {
      case 'rotate': return {
        title: translate('runtime.properties.FederationPanel.rotateHMACSecret'),
        description: translate('runtime.templates.FederationPanel.thisWillGenerateANewHMACSecretFor', { p0: name }),
        confirmLabel: 'Rotate',
        variant: 'warning' as const,
      };
      case 'revoke': return {
        title: translate('runtime.properties.FederationPanel.revokePeer'),
        description: translate('runtime.templates.FederationPanel.thisWillStopAllFederationRelayTrafficWith', { p0: name }),
        confirmLabel: 'Revoke',
        variant: 'danger' as const,
      };
      case 'reinitiate': return {
        title: translate('runtime.properties.FederationPanel.reInitiatePeering'),
        description: translate('runtime.templates.FederationPanel.thisWillDeleteTheRevokedRecordAndStart', { p0: confirmAction.peer.origin }),
        confirmLabel: 'Re-initiate',
        variant: 'warning' as const,
      };
      case 'delete': return {
        title: translate('runtime.properties.FederationPanel.deletePeerRecord'),
        description: translate('runtime.templates.FederationPanel.thisWillPermanentlyDeleteThePeerRecordFor', { p0: name }),
        confirmLabel: 'Delete',
        variant: 'danger' as const,
      };
      case 'reset': return {
        title: translate('runtime.properties.FederationPanel.resetPeering'),
        description: translate('runtime.templates.FederationPanel.resetPeeringWithThisDeletesTheLocalPeer', { p0: name }),
        confirmLabel: 'Reset',
        variant: 'danger' as const,
      };
    }
  })() : null;

  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary"><Trans i18nKey="ui.FederationPanel.federation">Federation</Trans></h2>
      <div className="text-xs text-txt-tertiary">
        <Trans i18nKey="ui.FederationPanel.configureFederationRelaySecretRotationAndManagePeered">Configure federation relay, secret rotation, and manage peered instances.</Trans>
      </div>

      <FederationGlobalSettings />

      <ResetCleanup />

      <PendingApprovals onCountChange={handleApprovalCountChange} />

      {/* Peered Instances */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider"><Trans i18nKey="ui.FederationPanel.peeredInstances">Peered Instances</Trans></div>
          <button
            type="button"
            onClick={fetchPeers}
            disabled={peersLoading}
            className="text-[11px] text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
          >
            {peersLoading ? translate('runtime.expressions.FederationPanel.loading') : translate('runtime.expressions.FederationPanel.refresh')}
          </button>
        </div>

        <div className="rounded-lg bg-white/[0.02] p-3.5">
          {peers.length > 0 && (
            <PeerListControls
              view={view}
              setView={setView}
              activeCount={activePeers.length}
              revokedCount={revokedPeers.length}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />
          )}

          {peersError && (
            <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs mb-2">
              {peersError}
              <button type="button" onClick={fetchPeers} className="ml-2 underline"><Trans i18nKey="ui.FederationPanel.retry">Retry</Trans></button>
            </div>
          )}

          {sortedPeers.length > 0 && (
            <div className="space-y-2">
              {sortedPeers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  peer={peer}
                  view={view}
                  expanded={expandedPeerId === peer.id}
                  onToggleExpand={() => setExpandedPeerId(expandedPeerId === peer.id ? null : peer.id)}
                  onAction={(type) => setConfirmAction({ type, peer })}
                  onRecheck={() => handleRecheck(peer)}
                  recheckLoading={recheckingId === peer.id}
                  defaultAutoRotateIntervalDays={useSettingsStore.getState().instanceSettings?.defaultAutoRotateIntervalDays ?? 90}
                />
              ))}
            </div>
          )}

          {emptyMessage && !peersError && !peersLoading && (
            <div className="text-xs text-txt-tertiary py-2">{emptyMessage}</div>
          )}
        </div>
      </div>

      {confirmAction && confirmDialogProps && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => { if (!actionLoading) setConfirmAction(null); }}
          onConfirm={handleConfirmAction}
          title={confirmDialogProps.title}
          description={confirmDialogProps.description}
          confirmLabel={confirmDialogProps.confirmLabel}
          variant={confirmDialogProps.variant}
          loading={actionLoading}
        />
      )}
    </form>
  );
}
