import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import type { InstanceAdminSettings } from '@backspace/shared';

export function GeneralPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<InstanceAdminSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [gifKeyDirty, setGifKeyDirty] = useState(false);
  const [gifKeyDraft, setGifKeyDraft] = useState('');

  useEffect(() => {
    if (instanceSettings) {
      setDraft({ ...instanceSettings });
      setGifKeyDraft('');
      setGifKeyDirty(false);
    }
  }, [instanceSettings]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const baseChanges = instanceSettings && draft
    ? draft.instanceName !== instanceSettings.instanceName ||
      draft.registrationOpen !== instanceSettings.registrationOpen ||
      draft.discoveryEnabled !== instanceSettings.discoveryEnabled
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
