import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AiConnection,
  ConnectionInput,
  TranslationCommand,
  TranslationPreferences,
  TranslationReply,
} from '@backspace/shared/translation';
import { TranslationPreferenceControls } from './TranslationPreferenceControls';
import { ConnectionEditor } from './ConnectionEditor';
import { ComposerActionEditor } from './ComposerActionEditor';
import { DEFAULT_COMPOSER_ACTIONS } from './composerPresets';
import { Toggle } from '../../components/ui/Toggle';
import { translationErrorText } from './errorText';
import { useTranslationSettings } from './useMessageTranslation';
import {
  acceptTranslationSettings,
  loadTranslationSettings,
  resumeAutomaticTranslation,
  sendTranslationCommand,
  useTranslationStore,
} from './translationStore';

export function TranslationPanel() {
  const context = useTranslationSettings();
  return <ScopedTranslationPanel key={context.scope} context={context} />;
}
function SelectedConnectionEditor({
  editor,
  ...props
}: Omit<React.ComponentProps<typeof ConnectionEditor>, 'connection'> & {
  editor: AiConnection | 'new';
}) {
  const connection = editor === 'new' ? undefined : editor;
  return <ConnectionEditor {...props} key={connection?.id ?? 'new'} connection={connection} />;
}
function ScopedTranslationPanel({ context }: { context: ReturnType<typeof useTranslationSettings> }) {
  const { t } = useTranslation('translation');
  const { scope, accountId, settings } = context;
  const loadError = useTranslationStore((s) => s.loadError);
  const automaticError = useTranslationStore((s) => s.automaticError);
  const [activeTab, setActiveTab] = useState<'all' | 'plugins' | 'connections'>('all');
  const [preferences, setPreferences] = useState<TranslationPreferences | null>(null);
  const [editor, setEditor] = useState<AiConnection | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreferences(settings?.preferences ?? null);
  }, [settings]);
  useEffect(() => {
    setEditor(null);
    setError(null);
  }, [scope]);
  const execute = async (command: TranslationCommand): Promise<TranslationReply> => {
    setBusy(true);
    setError(null);
    const startedSettings = useTranslationStore.getState().settings;
    const reply = await sendTranslationCommand(command);
    setBusy(false);
    // An old modal must not apply results after logout, account switching or another settings change.
    const current = useTranslationStore.getState();
    if (current.scope !== scope || current.settings !== startedSettings)
      return { ok: false, code: 'stale-settings' };
    if (!reply.ok) setError(translationErrorText(reply));
    return reply;
  };
  const saveConnection = async (connection: ConnectionInput): Promise<boolean> => {
    const reply = await execute({
      action: 'saveConnection',
      accountId,
      connection,
    });
    if (!reply.ok || !('settings' in reply) || useTranslationStore.getState().scope !== scope) return false;
    acceptTranslationSettings(reply.settings);
    setEditor(null);
    return true;
  };
  const removeConnection = async (id: string) => {
    const reply = await execute({ action: 'deleteConnection', accountId, id });
    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope)
      acceptTranslationSettings(reply.settings);
  };
  const savePreferences = async () => {
    if (!preferences || !settings) return;
    const reply = await execute({
      action: 'savePreferences',
      accountId,
      preferences,
    });
    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope)
      acceptTranslationSettings(reply.settings);
  };
  if (!settings || !preferences)
    return (
      <section className="space-y-4 text-txt-primary">
        <h2 className="text-lg font-semibold text-txt-primary">{t('title')}</h2>
        {loadError ? (
          <>
            <p role="alert" className="rounded-lg border border-accent-rose/30 bg-accent-rose/10 p-3 text-sm text-txt-danger">{translationErrorText(loadError)}</p>
            <button type="button" className="rounded px-3 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-sm text-txt-secondary transition-colors" onClick={() => void loadTranslationSettings({ scope, accountId, reload: true })}>
              {t('retry')}
            </button>
          </>
        ) : (
          <p role="status" className="text-sm text-txt-tertiary">{t('loading')}</p>
        )}
      </section>
    );

  const showPlugins = activeTab === 'all' || activeTab === 'plugins';
  const showConnections = activeTab === 'all' || activeTab === 'connections';

  return (
    <section className="space-y-5 text-txt-primary">
      <TranslationPrivacyNotice />

      {/* Tab Switcher */}
      <div className="flex bg-white/[0.04] rounded-md p-0.5 w-fit border border-white/[0.06]">
        <button
          type="button"
          onClick={() => setActiveTab('all')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeTab === 'all'
              ? 'bg-white/[0.08] text-txt-primary shadow-sm'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          {t('tabAll')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('plugins')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeTab === 'plugins'
              ? 'bg-white/[0.08] text-txt-primary shadow-sm'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          {t('tabPlugins')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('connections')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            activeTab === 'connections'
              ? 'bg-white/[0.08] text-txt-primary shadow-sm'
              : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          {t('tabConnections')}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-txt-danger">
          {error}
        </p>
      )}

      {/* AI Plugins Section */}
      {showPlugins && (
        <div className="space-y-4">
          <div>
            <h3 className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider">
              {t('pluginsSectionTitle')}
            </h3>
            <p className="text-xs text-txt-tertiary mt-0.5">{t('pluginsSectionDesc')}</p>
          </div>

          {/* Translation Plugin Card */}
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-accent-primary/10 text-accent-primary flex items-center justify-center shrink-0 mt-0.5 border border-accent-primary/20">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.48H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-txt-primary">{t('translationPluginName')}</span>
                    <span className="glass-pill px-2 py-0.5 text-[10px] text-accent-lavender font-medium">{t('builtInPlugin')}</span>
                  </div>
                  <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t('translationPluginDesc')}</p>
                </div>
              </div>
              <Toggle
                ariaLabel={t('translationPluginName')}
                enabled={preferences.translationEnabled !== false}
                disabled={busy}
                onChange={(enabled) => {
                  const updated = { ...preferences, translationEnabled: enabled };
                  setPreferences(updated);
                  void execute({ action: 'savePreferences', accountId, preferences: updated }).then((reply) => {
                    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope) {
                      acceptTranslationSettings(reply.settings);
                    }
                  });
                }}
              />
            </div>

            {preferences.translationEnabled !== false ? (
              <>
                <div className="pt-2 border-t border-white/[0.06]">
                  <TranslationPreferenceControls
                    preferences={preferences}
                    settings={settings}
                    busy={busy}
                    onChange={setPreferences}
                    onSave={() => void savePreferences()}
                  />
                </div>

                {automaticError && (
                  <div role="alert" className="text-sm text-txt-danger pt-1">
                    {t('automaticPaused')} {translationErrorText(automaticError)}{' '}
                    <button className="underline" onClick={resumeAutomaticTranslation}>
                      {t('resume')}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-txt-tertiary pt-2 border-t border-white/[0.06]">{t('pluginDisabledHint')}</p>
            )}
          </div>

          {/* Plugin: Chat Summarizer */}
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-accent-sky/10 text-accent-sky flex items-center justify-center shrink-0 mt-0.5 border border-accent-sky/20">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-txt-primary">{t('summarizerPluginName')}</span>
                    <span className="glass-pill px-2 py-0.5 text-[10px] text-accent-lavender font-medium">{t('builtInPlugin')}</span>
                  </div>
                  <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t('summarizerPluginDesc')}</p>
                </div>
              </div>
              <Toggle
                ariaLabel={t('summarizerPluginName')}
                enabled={!!preferences.summarizerEnabled}
                disabled={busy}
                onChange={(enabled) => {
                  const updated = { ...preferences, summarizerEnabled: enabled };
                  setPreferences(updated);
                  void execute({ action: 'savePreferences', accountId, preferences: updated }).then((reply) => {
                    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope) {
                      acceptTranslationSettings(reply.settings);
                    }
                  });
                }}
              />
            </div>

            {preferences.summarizerEnabled ? (
              <div className="pt-2 border-t border-white/[0.06] space-y-3">
                <label className="block text-xs font-medium text-txt-secondary">
                  {t('pluginAiConnection')}
                  <select
                    className="input-standard mt-1.5 w-full"
                    value={preferences.summarizerConnection ?? ''}
                    onChange={(e) => {
                      const updated = { ...preferences, summarizerConnection: e.target.value || null };
                      setPreferences(updated);
                    }}
                  >
                    <option value="">
                      {preferences.defaultConnection
                        ? `${t('inherit')} (${settings.connections.find((c) => c.id === preferences.defaultConnection)?.name ?? preferences.defaultConnection})`
                        : t('none')}
                    </option>
                    {settings.connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-sm font-medium text-white transition-colors disabled:opacity-50"
                    onClick={() => void savePreferences()}
                    disabled={busy}
                  >
                    {t('saveSummarizerSettings')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-txt-tertiary pt-2 border-t border-white/[0.06]">{t('pluginDisabledHint')}</p>
            )}
          </div>

          {/* Plugin: Composer Assistant */}
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-accent-lavender/10 text-accent-lavender flex items-center justify-center shrink-0 mt-0.5 border border-accent-lavender/20">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-txt-primary">{t('composerPluginName')}</span>
                    <span className="glass-pill px-2 py-0.5 text-[10px] text-accent-lavender font-medium">{t('builtInPlugin')}</span>
                  </div>
                  <p className="text-xs text-txt-tertiary mt-1 leading-relaxed">{t('composerPluginDesc')}</p>
                </div>
              </div>
              <Toggle
                ariaLabel={t('composerPluginName')}
                enabled={!!preferences.composerEnabled}
                disabled={busy}
                onChange={(enabled) => {
                  const updated = { ...preferences, composerEnabled: enabled };
                  setPreferences(updated);
                  void execute({ action: 'savePreferences', accountId, preferences: updated }).then((reply) => {
                    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope) {
                      acceptTranslationSettings(reply.settings);
                    }
                  });
                }}
              />
            </div>

            {preferences.composerEnabled ? (
              <div className="pt-2 border-t border-white/[0.06] space-y-3">
                <label className="block text-xs font-medium text-txt-secondary">
                  {t('pluginAiConnection')}
                  <select
                    className="input-standard mt-1.5 w-full"
                    value={preferences.composerConnection ?? ''}
                    onChange={(e) => {
                      const updated = { ...preferences, composerConnection: e.target.value || null };
                      setPreferences(updated);
                    }}
                  >
                    <option value="">
                      {preferences.defaultConnection
                        ? `${t('inherit')} (${settings.connections.find((c) => c.id === preferences.defaultConnection)?.name ?? preferences.defaultConnection})`
                        : t('none')}
                    </option>
                    {settings.connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>

                <ComposerActionEditor
                  actions={preferences.composerActions ?? DEFAULT_COMPOSER_ACTIONS}
                  disabled={busy}
                  onChange={(composerActions) => {
                    const updated = { ...preferences, composerActions };
                    setPreferences(updated);
                  }}
                />

                <div className="flex justify-end">
                  <button
                    type="button"
                    className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-sm font-medium text-white transition-colors disabled:opacity-50"
                    onClick={() => void savePreferences()}
                    disabled={busy}
                  >
                    {t('saveComposerSettings')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-txt-tertiary pt-2 border-t border-white/[0.06]">{t('pluginDisabledHint')}</p>
            )}
          </div>
        </div>
      )}

      {/* AI Connections Section */}
      {showConnections && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider">{t('connections')}</h3>
              <p className="text-xs text-txt-tertiary mt-0.5">{t('connectionsSectionDesc')}</p>
            </div>
            {!editor && (
              <button
                disabled={busy}
                className="rounded px-3 py-1.5 text-xs font-medium text-txt-secondary bg-white/[0.06] hover:bg-white/[0.1] transition-colors whitespace-nowrap shrink-0"
                onClick={() => setEditor('new')}
              >
                {t('addConnection')}
              </button>
            )}
          </div>

          {settings.connections.length > 0 && !editor && (
            <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-white/[0.03] border border-white/[0.04]">
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary">{t('globalConnection')}</div>
                <p className="text-xs text-txt-tertiary mt-0.5">{t('globalConnectionDesc')}</p>
              </div>
              <select
                className="input-standard w-48 shrink-0 text-xs"
                value={preferences.defaultConnection ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const val = e.target.value || null;
                  const updated = { ...preferences, defaultConnection: val };
                  setPreferences(updated);
                  void execute({ action: 'savePreferences', accountId, preferences: updated }).then((reply) => {
                    if (reply.ok && 'settings' in reply && useTranslationStore.getState().scope === scope) {
                      acceptTranslationSettings(reply.settings);
                    }
                  });
                }}
              >
                <option value="">{t('none')}</option>
                {settings.connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          {!settings.connections.length && !editor && (
            <p className="rounded-lg border border-dashed border-white/[0.1] p-4 text-sm text-txt-tertiary">{t('noConnections')}</p>
          )}
          {settings.connections.map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{connection.name}</div>
                <div className="truncate text-xs text-txt-tertiary">
                  {connection.protocol} · {connection.model} · {connection.baseUrl}
                </div>
              </div>
              <button disabled={busy} className="rounded px-2 py-1.5 text-xs text-txt-secondary hover:bg-white/[0.06] transition-colors" onClick={() => setEditor(connection)}>
                {t('edit')}
              </button>
              <button
                disabled={busy}
                className="rounded px-2 py-1.5 text-xs text-txt-danger hover:bg-accent-rose/10 transition-colors"
                onClick={() => void removeConnection(connection.id)}
              >
                {t('delete')}
              </button>
            </div>
          ))}
          {editor && (
            <SelectedConnectionEditor
              editor={editor}
              busy={busy}
              onSave={saveConnection}
              onDiagnose={command => sendTranslationCommand({ ...command, accountId }).then(reply =>
                useTranslationStore.getState().scope === scope ? reply : { ok: false, code: 'stale-settings' })}
              onCancel={() => setEditor(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function TranslationPrivacyNotice() {
  const { t } = useTranslation('translation');
  return (
    <header>
      <h2 className="text-lg font-semibold text-txt-primary">{t('title')}</h2>
      <p className="mt-1.5 text-sm text-txt-tertiary">{t(window.backspace?.translation ? 'localSummary' : 'serverSummary')}</p>
      <details className="mt-3 rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <summary className="cursor-pointer text-xs font-medium text-txt-secondary">{t('privacyDetails')}</summary>
        <p className="mt-2 text-xs text-txt-tertiary leading-relaxed">{t(window.backspace?.translation ? 'privacy' : 'serverPrivacy')}</p>
      </details>
    </header>
  );
}
