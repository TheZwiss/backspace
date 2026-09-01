import { useState, useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import type { InstanceAdminSettings } from '@backspace/shared';
import { Trans } from 'react-i18next';
import { translate } from '../../../i18n';

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

  if (!draft) return <div className="text-sm text-txt-tertiary"><Trans i18nKey="ui.GeneralPanel.loadingSettings">Loading settings...</Trans></div>;

  const baseChanges = instanceSettings && draft
    ? draft.instanceName !== instanceSettings.instanceName ||
      draft.discoveryEnabled !== instanceSettings.discoveryEnabled
    : false;
  const hasChanges = baseChanges || gifKeyDirty;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Partial<InstanceAdminSettings> = {
        instanceName: draft!.instanceName,
        discoveryEnabled: draft!.discoveryEnabled,
      };
      if (gifKeyDirty) {
        payload.gifApiKey = gifKeyDraft;
      }
      await updateInstanceSettings(payload);
      setGifKeyDirty(false);
      setGifKeyDraft('');
      addToast(translate('runtime.messages.GeneralPanel.settingsSaved'), 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : translate('runtime.messages.GeneralPanel.failedToSave'));
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
      <h2 className="text-lg font-semibold text-txt-primary"><Trans i18nKey="ui.GeneralPanel.general">General</Trans></h2>
      <div className="text-xs text-txt-tertiary">
        <Trans i18nKey="ui.GeneralPanel.configureYourBackspaceInstanceTheseSettingsAffectAll">Configure your Backspace instance. These settings affect all users.</Trans>
      </div>

      {/* Instance Name */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5"><Trans i18nKey="ui.GeneralPanel.instanceName">Instance Name</Trans></div>
        <p className="text-xs text-txt-tertiary mb-2"><Trans i18nKey="ui.GeneralPanel.theNameShownOnTheLoginPageAnd">The name shown on the login page and to federated instances.</Trans></p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <input
            type="text"
            value={draft.instanceName}
            onChange={(e) => setDraft({ ...draft, instanceName: e.target.value.slice(0, 32) })}
            placeholder={translate("runtime.attributes.GeneralPanel.backspace")}
            className="input-standard w-full"
          />
          <div className="text-[11px] text-txt-tertiary text-right mt-1">{draft.instanceName.length}/32</div>
        </div>
      </div>

      {/* Discovery */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5"><Trans i18nKey="ui.GeneralPanel.discovery">Discovery</Trans></div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <div className="text-sm font-medium text-txt-primary"><Trans i18nKey="ui.GeneralPanel.spaceDiscovery">Space Discovery</Trans></div>
              <div className="text-xs text-txt-tertiary mt-0.5"><Trans i18nKey="ui.GeneralPanel.allowSpacesToAppearInThePublicExplore">Allow spaces to appear in the public Explore page</Trans></div>
            </div>
            <Toggle enabled={draft.discoveryEnabled} onChange={(v) => setDraft({ ...draft, discoveryEnabled: v })} />
          </label>
        </div>
      </div>

      {/* GIF Search */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5"><Trans i18nKey="ui.GeneralPanel.gifSearch">GIF Search</Trans></div>
        <p className="text-xs text-txt-tertiary mb-2">
          <Trans i18nKey="ui.GeneralPanel.enableGIFSearchPoweredByKlipyGetA">Enable GIF search powered by Klipy. Get a free API key from the Klipy developer portal.</Trans>
        </p>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2">
          <input
            type="password"
            value={gifKeyDirty ? gifKeyDraft : ''}
            onChange={(e) => { setGifKeyDraft(e.target.value); setGifKeyDirty(true); }}
            placeholder={draft.gifEnabled ? translate('runtime.expressions.GeneralPanel.keySavedEnterNewKeyToReplace') : translate('runtime.expressions.GeneralPanel.klipyAPIKey')}
            className="input-standard w-full"
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
              draft.gifEnabled ? 'bg-status-online/15 text-status-online' : 'bg-white/5 text-txt-tertiary'
            }`}>
              {draft.gifEnabled ? translate('runtime.expressions.GeneralPanel.enabled') : translate('runtime.expressions.GeneralPanel.notConfigured')}
            </span>
            {draft.gifEnabled && !gifKeyDirty && (
              <button
                onClick={() => { setGifKeyDraft(''); setGifKeyDirty(true); }}
                className="text-[11px] text-txt-tertiary hover:text-txt-danger transition-colors"
              >
                <Trans i18nKey="ui.GeneralPanel.clearKey">Clear key</Trans>
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
                <Trans i18nKey="ui.GeneralPanel.reset">Reset</Trans>
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? translate('runtime.expressions.GeneralPanel.saving') : translate('runtime.expressions.GeneralPanel.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
