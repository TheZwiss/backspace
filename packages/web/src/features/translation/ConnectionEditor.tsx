import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiConnection, ConnectionInput, ConnectionProbe, TranslationProtocol, TranslationReply } from '@backspace/shared/translation';
import { Toggle } from '../../components/ui/Toggle';
import { translationErrorText } from './errorText';

// These are protocol product names, not translatable UI prose.
const PROTOCOLS = {
  'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages', gemini: 'Google Gemini',
} as const;
const EMPTY_CONNECTION = { name: '', protocol: 'openai-chat' as const, baseUrl: 'https://api.openai.com/v1', model: '', hasKey: false };
function recipientChanged(connection: AiConnection | undefined, baseUrl: string, protocol: TranslationProtocol): boolean {
  return !!connection?.hasKey &&
    (baseUrl.trim().replace(/\/+$/, '') !== connection.baseUrl || protocol !== connection.protocol);
}
interface EditorProps {
  connection?: AiConnection;
  busy: boolean;
  onSave: (input: ConnectionInput) => Promise<boolean>;
  onDiagnose: (input: { action: 'listModels' | 'testConnection'; connection: ConnectionProbe }) => Promise<TranslationReply>;
  onCancel: () => void;
}
export function ConnectionEditor({ connection, busy, onSave, onDiagnose, onCancel }: EditorProps) {
  const { t } = useTranslation('translation');
  const initial = connection ?? EMPTY_CONNECTION;
  const [name, setName] = useState(initial.name);
  const [protocol, setProtocol] = useState<TranslationProtocol>(initial.protocol);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [operation, setOperation] = useState<'listModels' | 'testConnection' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [test, setTest] = useState<{ latencyMs: number; text: string } | null>(null);
  const changedRecipient = recipientChanged(connection, baseUrl, protocol);
  const locked = busy || operation !== null;
  const blocked = changedRecipient && !apiKey && !clearKey;
  const draft: ConnectionProbe = { id: connection?.id, protocol, baseUrl, apiKey: clearKey ? '' : apiKey || undefined };
  // Results describe this unsaved recipient; changing its credentials invalidates discovery and tests.
  const resetDiagnostics = () => { setModels(null); setFailure(null); setTest(null); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || blocked) return;
    // Empty means keep the saved secret; explicit unauthenticated mode removes it.
    if (await onSave({ ...draft, name, model })) setApiKey('');
  };
  const diagnose = async (action: 'listModels' | 'testConnection') => {
    if (locked || blocked) return;
    setOperation(action);
    setFailure(null);
    setTest(null);
    if (action === 'listModels') setModels(null);
    try {
      const reply = await onDiagnose({ action, connection: { ...draft, ...(action === 'testConnection' ? { model } : {}) } });
      if (!reply.ok) setFailure(translationErrorText(reply));
      else if ('models' in reply) setModels(reply.models);
      else if ('test' in reply) setTest(reply.test);
      else setFailure(translationErrorText({ ok: false, code: 'invalid-response' }));
    } catch { setFailure(translationErrorText({ ok: false, code: 'network' })); }
    finally { setOperation(null); }
  };
  return (
    <form onSubmit={event => void submit(event)} className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
      <fieldset disabled={locked} className="space-y-4 min-w-0">
        <legend className="text-sm font-semibold text-txt-primary mb-4">{t(connection ? 'editConnection' : 'addConnection')}</legend>
        <div className="grid grid-cols-1 desktop:grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-txt-secondary">
            {t('connectionName')}
            <input required maxLength={80} className="input-standard mt-1.5 w-full" value={name}
              onChange={event => setName(event.target.value)} />
          </label>
          <label className="block text-xs font-medium text-txt-secondary">
            {t('protocol')}
            <select className="input-standard mt-1.5 w-full" value={protocol}
              onChange={event => { setProtocol(event.target.value as TranslationProtocol); resetDiagnostics(); }}>
              {Object.entries(PROTOCOLS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <ConnectionCredentials baseUrl={baseUrl} apiKey={apiKey} clearKey={clearKey}
          hasKey={initial.hasKey} changedRecipient={changedRecipient}
          onBaseUrl={value => { setBaseUrl(value); resetDiagnostics(); }}
          onApiKey={value => { setApiKey(value); resetDiagnostics(); }}
          onClearKey={enabled => { setClearKey(enabled); setApiKey(''); resetDiagnostics(); }} />
        <ConnectionModelControls model={model} models={models} baseUrl={baseUrl} blocked={blocked}
          operation={operation} diagnose={diagnose}
          onModel={value => { setModel(value); setTest(null); setFailure(null); }} />
        <ConnectionDiagnosticFeedback operation={operation} failure={failure} test={test} />
        <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded text-sm text-txt-secondary hover:bg-white/[0.06] transition-colors">{t('cancel')}</button>
          <button type="submit" disabled={blocked} className="px-4 py-2 rounded bg-accent-primary hover:bg-accent-primary-hover text-sm font-medium text-white transition-colors disabled:opacity-50">{t('saveConnection')}</button>
        </div>
      </fieldset>
    </form>
  );
}

interface CredentialsProps {
  baseUrl: string; apiKey: string; clearKey: boolean; hasKey: boolean; changedRecipient: boolean;
  onBaseUrl: (value: string) => void; onApiKey: (value: string) => void; onClearKey: (value: boolean) => void;
}
function ConnectionCredentials({ baseUrl, apiKey, clearKey, hasKey, changedRecipient, onBaseUrl, onApiKey, onClearKey }: CredentialsProps) {
  const { t } = useTranslation('translation');
  return (
    <>
      <div>
        <label className="block text-xs font-medium text-txt-secondary">
          {t('baseUrl')}
          <input type="url" required maxLength={2048} spellCheck={false} className="input-standard mt-1.5 w-full"
            value={baseUrl} onChange={event => onBaseUrl(event.target.value)} />
        </label>
        <p className="text-xs text-txt-tertiary mt-1.5 leading-relaxed">{t(window.backspace?.translation ? 'baseUrlHelp' : 'serverBaseUrlHelp')}</p>
      </div>
      <label className="block text-xs font-medium text-txt-secondary">
        {t('apiKey')}
        <input type="password" autoComplete="off" spellCheck={false} maxLength={4096} disabled={clearKey}
          className="input-standard mt-1.5 w-full" placeholder={hasKey ? t('keyStored') : t('keyOptional')}
          value={apiKey} onChange={event => onApiKey(event.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-txt-secondary">{t('noKey')}</span>
        <Toggle ariaLabel={t('noKey')} enabled={clearKey} onChange={onClearKey} />
      </div>
      {changedRecipient && <p className="text-xs text-txt-danger">{t('recipientChanged')}</p>}
    </>
  );
}

interface ModelControlsProps {
  model: string; models: string[] | null; baseUrl: string; blocked: boolean;
  operation: 'listModels' | 'testConnection' | null;
  onModel: (value: string) => void; diagnose: (action: 'listModels' | 'testConnection') => Promise<void>;
}
function ConnectionModelControls({ model, models, baseUrl, blocked, operation, onModel, diagnose }: ModelControlsProps) {
  const { t } = useTranslation('translation');
  return (
    <>
      <div className="border-t border-white/[0.06] pt-4 space-y-2">
        <div className="flex items-end gap-2">
          <label className="block text-xs font-medium text-txt-secondary flex-1 min-w-0">
            {t('model')}
            <input required maxLength={160} className="input-standard mt-1.5 w-full" value={model}
              onChange={event => onModel(event.target.value)} />
          </label>
          <button type="button" disabled={blocked || !baseUrl.trim()} onClick={() => void diagnose('listModels')}
            className="px-3 py-2 rounded bg-white/[0.06] hover:bg-white/[0.1] text-sm text-txt-primary transition-colors disabled:opacity-50 shrink-0">
            {t(operation === 'listModels' ? 'fetchingModels' : 'fetchModels')}
          </button>
        </div>
        <p className="text-xs text-txt-tertiary">{t('modelHelp')}</p>
        {models !== null && (models.length ? (
          <label className="block text-xs text-txt-secondary">
            {t('availableModels', { total: models.length })}
            <select className="input-standard mt-1.5 w-full" value={models.includes(model) ? model : ''}
              onChange={event => onModel(event.target.value)}>
              <option value="" disabled>{t('selectModel')}</option>
              {models.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        ) : <p role="status" className="text-xs text-txt-tertiary">{t('noModels')}</p>)}
      </div>
      <div className="space-y-2">
        <button type="button" disabled={blocked || !baseUrl.trim() || !model.trim()} onClick={() => void diagnose('testConnection')}
          className="px-3 py-2 rounded bg-white/[0.06] hover:bg-white/[0.1] text-sm text-txt-primary transition-colors disabled:opacity-50">
          {t(operation === 'testConnection' ? 'testingConnection' : 'testConnection')}
        </button>
        <p className="text-xs text-txt-tertiary leading-relaxed">{t('diagnosticHelp')}</p>
      </div>
    </>
  );
}

interface DiagnosticFeedbackProps {
  operation: 'listModels' | 'testConnection' | null;
  failure: string | null; test: { latencyMs: number; text: string } | null;
}
function ConnectionDiagnosticFeedback({ operation, failure, test }: DiagnosticFeedbackProps) {
  const { t } = useTranslation('translation');
  return (
    <>
      {operation && <p role="status" className="text-xs text-txt-secondary">{t(operation === 'listModels' ? 'fetchingModels' : 'testingConnection')}</p>}
      {failure && <p role="alert" className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{failure}</p>}
      {test && <div role="status" className="rounded bg-accent-primary/10 border border-accent-primary/20 p-3 text-sm">
        <div className="font-medium text-txt-primary">{t('connectionReady', { ms: test.latencyMs })}</div>
        <p className="mt-1 text-txt-secondary whitespace-pre-wrap break-words">{test.text}</p>
      </div>}
    </>
  );
}
