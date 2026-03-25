import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { api } from '../../../api/client';
import type { InstanceAdminSettings } from '@backspace/shared';

interface FederationPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: string;
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

export function GeneralPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<InstanceAdminSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [gifKeyDirty, setGifKeyDirty] = useState(false);
  const [gifKeyDraft, setGifKeyDraft] = useState('');

  // Federation peers state
  const [peers, setPeers] = useState<FederationPeer[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [revokingPeerId, setRevokingPeerId] = useState<string | null>(null);

  useEffect(() => {
    if (instanceSettings) {
      setDraft({ ...instanceSettings });
      setGifKeyDraft('');
      setGifKeyDirty(false);
    }
  }, [instanceSettings]);

  const fetchPeers = useCallback(async () => {
    setPeersLoading(true);
    try {
      const result = await api.federation.peers();
      setPeers(result.peers);
    } catch {
      // Non-critical — peers list may fail on instances without federation routes
    } finally {
      setPeersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeers();
  }, [fetchPeers]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const baseChanges = instanceSettings && draft
    ? draft.instanceName !== instanceSettings.instanceName ||
      draft.registrationOpen !== instanceSettings.registrationOpen ||
      draft.discoveryEnabled !== instanceSettings.discoveryEnabled ||
      draft.federationRelayEnabled !== instanceSettings.federationRelayEnabled ||
      draft.federationRelayTtlDays !== instanceSettings.federationRelayTtlDays
    : false;
  const hasChanges = baseChanges || gifKeyDirty;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Partial<InstanceAdminSettings> = {
        instanceName: draft!.instanceName,
        registrationOpen: draft!.registrationOpen,
        discoveryEnabled: draft!.discoveryEnabled,
        federationRelayEnabled: draft!.federationRelayEnabled,
        federationRelayTtlDays: draft!.federationRelayTtlDays,
      };
      if (gifKeyDirty) {
        payload.gifApiKey = gifKeyDraft;
      }
      await updateInstanceSettings(payload);
      setGifKeyDirty(false);
      setGifKeyDraft('');
      addToast('Settings saved', 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) setDraft({ ...instanceSettings });
    setGifKeyDirty(false);
    setGifKeyDraft('');
    setSaveError('');
  };

  const handleRevokePeer = async (peerId: string) => {
    setRevokingPeerId(peerId);
    try {
      await api.federation.revokePeer(peerId);
      setPeers((prev) => prev.filter((p) => p.id !== peerId));
      addToast('Peer revoked', 'success', 2000);
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to revoke peer', 'warning', 3000);
    } finally {
      setRevokingPeerId(null);
    }
  };

  const formatRelativeTime = (timestamp: number | null): string => {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const peerStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'bg-status-online/15 text-status-online';
      case 'pending': return 'bg-accent-amber/15 text-accent-amber';
      case 'unreachable': return 'bg-accent-rose/15 text-txt-danger';
      case 'revoked': return 'bg-white/5 text-txt-tertiary';
      default: return 'bg-white/5 text-txt-tertiary';
    }
  };

  // Only show non-revoked peers
  const visiblePeers = peers.filter((p) => p.status !== 'revoked');

  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">General</h2>
      <div className="text-xs text-txt-tertiary">
        Configure your Backspace instance. These settings affect all users.
      </div>

      {/* Instance Name */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Instance Name</div>
        <p className="text-xs text-txt-tertiary mb-2">The name shown on the login page and to federated instances.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <input
            type="text"
            value={draft.instanceName}
            onChange={(e) => setDraft({ ...draft, instanceName: e.target.value.slice(0, 32) })}
            placeholder="Backspace"
            className="input-standard w-full"
          />
          <div className="text-[11px] text-txt-tertiary text-right mt-1">{draft.instanceName.length}/32</div>
        </div>
      </div>

      {/* Registration */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Registration</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm font-medium text-txt-primary">Open Registration</div>
              <div className="text-xs text-txt-tertiary mt-0.5">Allow new users to create accounts on this instance</div>
            </div>
            <Toggle enabled={draft.registrationOpen} onChange={(v) => setDraft({ ...draft, registrationOpen: v })} />
          </label>
        </div>
      </div>

      {/* Discovery */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Discovery</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm font-medium text-txt-primary">Space Discovery</div>
              <div className="text-xs text-txt-tertiary mt-0.5">Allow spaces to appear in the public Explore page</div>
            </div>
            <Toggle enabled={draft.discoveryEnabled} onChange={(v) => setDraft({ ...draft, discoveryEnabled: v })} />
          </label>
        </div>
      </div>

      {/* GIF Search */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">GIF Search</div>
        <p className="text-xs text-txt-tertiary mb-2">
          Enable GIF search powered by Klipy. Get a free API key from the Klipy developer portal.
        </p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2">
          <input
            type="password"
            value={gifKeyDirty ? gifKeyDraft : ''}
            onChange={(e) => { setGifKeyDraft(e.target.value); setGifKeyDirty(true); }}
            placeholder={draft.gifEnabled ? 'Key saved — enter new key to replace' : 'Klipy API key'}
            className="input-standard w-full"
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
              draft.gifEnabled ? 'bg-status-online/15 text-status-online' : 'bg-white/5 text-txt-tertiary'
            }`}>
              {draft.gifEnabled ? 'Enabled' : 'Not configured'}
            </span>
            {draft.gifEnabled && !gifKeyDirty && (
              <button
                onClick={() => { setGifKeyDraft(''); setGifKeyDirty(true); }}
                className="text-[11px] text-txt-tertiary hover:text-txt-danger transition-colors"
              >
                Clear key
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Federation */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Federation</div>
        <p className="text-xs text-txt-tertiary mb-2">
          Control DM relay between federated instances. When enabled, DMs with users on peer instances are relayed server-to-server.
        </p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm font-medium text-txt-primary">Enable DM Relay</div>
              <div className="text-xs text-txt-tertiary mt-0.5">Relay direct messages to and from peer instances</div>
            </div>
            <Toggle enabled={draft.federationRelayEnabled} onChange={(v) => setDraft({ ...draft, federationRelayEnabled: v })} />
          </label>

          <div>
            <div className="text-sm font-medium text-txt-primary mb-1">Relay TTL (days)</div>
            <div className="text-xs text-txt-tertiary mb-2">How long relayed messages are retained in the outbox before cleanup</div>
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

          {/* Peers list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-txt-primary">Peered Instances</div>
              <button
                type="button"
                onClick={fetchPeers}
                disabled={peersLoading}
                className="text-[11px] text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
              >
                {peersLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {visiblePeers.length === 0 && !peersLoading && (
              <div className="text-xs text-txt-tertiary py-2">
                No federation peers configured. Peers are created automatically when connecting to remote instances.
              </div>
            )}

            {visiblePeers.length > 0 && (
              <div className="space-y-2">
                {visiblePeers.map((peer) => (
                  <div key={peer.id} className="flex items-center justify-between rounded-md bg-white/[0.02] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-txt-primary truncate">
                          {peer.instanceName || new URL(peer.origin).host}
                        </span>
                        <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${peerStatusColor(peer.status)}`}>
                          {peer.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-txt-tertiary truncate">{peer.origin}</div>
                      <div className="text-[11px] text-txt-tertiary">
                        Last seen: {formatRelativeTime(peer.lastSeenAt)}
                        {peer.lastSyncedAt ? ` · Synced: ${formatRelativeTime(peer.lastSyncedAt)}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRevokePeer(peer.id)}
                      disabled={revokingPeerId === peer.id}
                      className="ml-3 px-2.5 py-1 text-xs font-medium text-txt-danger bg-accent-rose/10 hover:bg-accent-rose/20 rounded transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {revokingPeerId === peer.id ? 'Revoking...' : 'Revoke'}
                    </button>
                  </div>
                ))}
              </div>
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
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
