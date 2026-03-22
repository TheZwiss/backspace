import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { Toggle } from '../../ui/Toggle';

export function GeneralPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);

  const [instanceName, setInstanceName] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [gifKeyDraft, setGifKeyDraft] = useState('');
  const [gifKeyDirty, setGifKeyDirty] = useState(false);

  useEffect(() => {
    if (instanceSettings) {
      setInstanceName(instanceSettings.instanceName);
      setGifKeyDraft('');
      setGifKeyDirty(false);
    }
  }, [instanceSettings]);

  const autoSave = useCallback(async (payload: Record<string, unknown>) => {
    setSaveStatus('saving');
    setSaveError('');
    try {
      await updateInstanceSettings(payload);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
      setSaveStatus('error');
      setTimeout(() => { setSaveStatus('idle'); setSaveError(''); }, 3000);
    }
  }, [updateInstanceSettings]);

  if (!instanceSettings) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const handleToggle = (key: string, value: boolean) => {
    autoSave({ [key]: value });
  };

  const handleInstanceNameBlur = () => {
    const trimmed = instanceName.trim();
    if (trimmed && trimmed !== instanceSettings.instanceName) {
      autoSave({ instanceName: trimmed });
    }
  };

  const handleGifKeyBlur = () => {
    if (gifKeyDirty) {
      autoSave({ gifApiKey: gifKeyDraft });
      setGifKeyDirty(false);
      setGifKeyDraft('');
    }
  };

  const handleClearGifKey = () => {
    autoSave({ gifApiKey: '' });
  };

  return (
    <div className="space-y-5">
      {/* Save status indicator */}
      {saveStatus === 'saving' && (
        <div className="text-xs text-txt-tertiary animate-pulse">Saving...</div>
      )}
      {saveStatus === 'saved' && (
        <div className="text-xs text-status-online">Saved</div>
      )}
      {saveStatus === 'error' && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}

      {/* Instance Name */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Instance Name</div>
        <p className="text-xs text-txt-tertiary mb-2">The name shown on the login page and to federated instances.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <input
            type="text"
            value={instanceName}
            onChange={(e) => setInstanceName(e.target.value.slice(0, 32))}
            onBlur={handleInstanceNameBlur}
            placeholder="Backspace"
            className="input-standard w-full"
          />
          <div className="text-[11px] text-txt-tertiary text-right mt-1">{instanceName.length}/32</div>
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
            <Toggle enabled={instanceSettings.registrationOpen} onChange={(v) => handleToggle('registrationOpen', v)} />
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
            <Toggle enabled={instanceSettings.discoveryEnabled} onChange={(v) => handleToggle('discoveryEnabled', v)} />
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
            onBlur={handleGifKeyBlur}
            placeholder={instanceSettings.gifEnabled ? 'Key saved — enter new key to replace' : 'Klipy API key'}
            className="input-standard w-full"
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
              instanceSettings.gifEnabled ? 'bg-status-online/15 text-status-online' : 'bg-white/5 text-txt-tertiary'
            }`}>
              {instanceSettings.gifEnabled ? 'Enabled' : 'Not configured'}
            </span>
            {instanceSettings.gifEnabled && !gifKeyDirty && (
              <button
                onClick={handleClearGifKey}
                className="text-[11px] text-txt-tertiary hover:text-txt-danger transition-colors"
              >
                Clear key
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
