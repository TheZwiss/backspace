import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';

interface RegistrationDraft {
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
}

export function RegistrationPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<RegistrationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (instanceSettings) {
      setDraft({
        registrationOpen: instanceSettings.registrationOpen,
        federatedRegistrationOpen: instanceSettings.federatedRegistrationOpen,
      });
      setSaveError('');
    }
  }, [instanceSettings]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const hasChanges = !!instanceSettings && (
    draft.registrationOpen !== instanceSettings.registrationOpen ||
    draft.federatedRegistrationOpen !== instanceSettings.federatedRegistrationOpen
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateInstanceSettings({
        registrationOpen: draft.registrationOpen,
        federatedRegistrationOpen: draft.federatedRegistrationOpen,
      });
      addToast('Registration settings saved', 'success', 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      setSaveError(message);
      addToast('Failed to update registration settings', 'warning');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) {
      setDraft({
        registrationOpen: instanceSettings.registrationOpen,
        federatedRegistrationOpen: instanceSettings.federatedRegistrationOpen,
      });
    }
    setSaveError('');
  };

  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">Registration</h2>
      <div className="text-xs text-txt-tertiary">
        Control who can create accounts on this instance. Public registration covers local
        sign-ups; federated registration covers users from peered instances creating an account here.
      </div>

      {/* Public registration */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Public Registration</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-txt-primary">Allow new local accounts</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                Anyone can create a local account from the registration page. When off, only invite
                links can create new local accounts.
              </div>
            </div>
            <Toggle
              enabled={draft.registrationOpen}
              onChange={(v) => setDraft({ ...draft, registrationOpen: v })}
            />
          </label>
        </div>
      </div>

      {/* Federated registration */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Federated Registration</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-txt-primary">Allow new federated accounts</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                Users from other instances can create a federated account here via their Connections
                settings. Existing federated accounts can always log in regardless of this setting.
              </div>
            </div>
            <Toggle
              enabled={draft.federatedRegistrationOpen}
              onChange={(v) => setDraft({ ...draft, federatedRegistrationOpen: v })}
            />
          </label>
        </div>
      </div>

      {/* Invite Links — populated in subsequent tasks */}
      <div className="border-t border-white/[0.06] pt-5">
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Invite Links</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 text-sm text-txt-tertiary">
          Invite-link UI will appear here.
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
