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
  return (
    <section className="space-y-5 text-txt-primary">
      <TranslationPrivacyNotice />
      {error && (
        <p role="alert" className="text-sm text-txt-danger">
          {error}
        </p>
      )}
      <div className="space-y-3">
        <h3 className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider">{t('connections')}</h3>
        {!settings.connections.length && !editor && <p className="rounded-lg border border-dashed border-white/[0.1] p-4 text-sm text-txt-tertiary">{t('noConnections')}</p>}
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
        {!editor && (
          <button disabled={busy} className="rounded px-3 py-2 text-sm text-txt-secondary bg-white/[0.06] hover:bg-white/[0.1] transition-colors" onClick={() => setEditor('new')}>
            {t('addConnection')}
          </button>
        )}
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
      <div className="space-y-4">
        <TranslationPreferenceControls
          preferences={preferences}
          settings={settings}
          busy={busy}
          onChange={setPreferences}
          onSave={() => void savePreferences()}
        />
        {automaticError && (
          <div role="alert" className="text-sm text-txt-danger">
            {t('automaticPaused')} {translationErrorText(automaticError)}{' '}
            <button className="underline" onClick={resumeAutomaticTranslation}>
              {t('resume')}
            </button>
          </div>
        )}
      </div>
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
