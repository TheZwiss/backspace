import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { api } from '../../../api/client';
import type { InstanceAdminSettings } from '@backspace/shared';
import type { FederationPeer } from '../../../api/client';

// ─── Global Settings ─────────────────────────────────────────────────────────

function FederationGlobalSettings() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<Pick<InstanceAdminSettings, 'federationRelayEnabled' | 'federationRelayTtlDays' | 'defaultAutoRotateIntervalDays'> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (instanceSettings) {
      setDraft({
        federationRelayEnabled: instanceSettings.federationRelayEnabled,
        federationRelayTtlDays: instanceSettings.federationRelayTtlDays,
        defaultAutoRotateIntervalDays: instanceSettings.defaultAutoRotateIntervalDays,
      });
    }
  }, [instanceSettings]);

  if (!draft) return null;

  const hasChanges = instanceSettings
    ? draft.federationRelayEnabled !== instanceSettings.federationRelayEnabled ||
      draft.federationRelayTtlDays !== instanceSettings.federationRelayTtlDays ||
      draft.defaultAutoRotateIntervalDays !== instanceSettings.defaultAutoRotateIntervalDays
    : false;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateInstanceSettings(draft);
      addToast('Settings saved', 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
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
      });
    }
    setSaveError('');
  };

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Relay Settings</div>
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

        <div>
          <div className="text-sm font-medium text-txt-primary mb-1">Default Secret Rotation (days)</div>
          <div className="text-xs text-txt-tertiary mb-2">Auto-rotation interval for new peers. Existing peers keep their current setting.</div>
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
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function FederationPanel() {
  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">Federation</h2>
      <div className="text-xs text-txt-tertiary">
        Configure federation relay, secret rotation, and manage peered instances.
      </div>

      <FederationGlobalSettings />
    </form>
  );
}
