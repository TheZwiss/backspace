import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { InstanceAdminSettings } from '@backspace/shared';

export function GeneralPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const [draft, setDraft] = useState<InstanceAdminSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (instanceSettings) setDraft({ ...instanceSettings });
  }, [instanceSettings]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(instanceSettings);

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      await updateInstanceSettings(draft);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) setDraft({ ...instanceSettings });
    setSaveError('');
  };

  return (
    <div className="space-y-5">
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
            className="w-full px-3 py-2 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-1 focus:ring-accent-primary placeholder:text-txt-tertiary"
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
            <button
              type="button"
              onClick={() => setDraft({ ...draft, registrationOpen: !draft.registrationOpen })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                draft.registrationOpen ? 'bg-accent-primary' : 'bg-interactive-muted'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  draft.registrationOpen ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
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
            <button
              type="button"
              onClick={() => setDraft({ ...draft, discoveryEnabled: !draft.discoveryEnabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                draft.discoveryEnabled ? 'bg-accent-primary' : 'bg-interactive-muted'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                  draft.discoveryEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </label>
        </div>
      </div>

      {/* Status messages */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {saveSuccess && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">Settings saved</div>
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
    </div>
  );
}
