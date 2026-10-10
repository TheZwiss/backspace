import type { TranslationReply } from '../../shared/src/translation';
import { listModels, testConnection } from './connectionDiagnostics';
import { translateAi } from './aiProtocols';
import { translateAnonymous } from './anonymousProviders';
import { protectText, restoreText, translationEligibility } from './textPolicy';
import type { TranslationFetch } from './transport';
import { TranslationVault, type StoredConnection } from './vault';
import { type ResultCache, translationResultKey } from './resultCache';
import type { TranslationLanguage } from '../../shared/src/translation';
import {
  ANONYMOUS_ENGINES,
  MAX_TEXT_LENGTH,
  TranslationError,
  accountId,
  connectionInput,
  connectionProbe,
  preferencesInput,
  record,
  string,
} from './validation';

/** Shared boundary for native IPC and authenticated HTTP; all input remains untrusted. */
export class TranslationService {
  private readonly active = new Map<string, { key: string; result: Promise<string> }>();
  constructor(
    private readonly vault: TranslationVault,
    private readonly fetcher: TranslationFetch,
    private readonly cache: ResultCache,
  ) {}
  async command(origin: string, raw: unknown): Promise<TranslationReply> {
    try {
      const input = record(raw);
      const scope = `${origin}\n${accountId(input.accountId)}`;
      switch (input.action) {
        case 'load':
          return { ok: true, settings: this.vault.snapshot(scope) };
        case 'saveConnection':
          return {
            ok: true,
            settings: this.vault.saveConnection(scope, connectionInput(input.connection)),
          };
        case 'deleteConnection':
          return {
            ok: true,
            settings: this.vault.deleteConnection(scope, string(input.id, 64)),
          };
        case 'savePreferences':
          return {
            ok: true,
            settings: this.vault.savePreferences(scope, preferencesInput(input.preferences)),
          };
        case 'listModels':
        case 'testConnection':
          return await this.diagnose(scope, input);
        case 'translate':
          return await this.translate(scope, input);
        default:
          throw new TranslationError('invalid-input');
      }
    } catch (error) {
      return commandFailure(error);
    }
  }
  private async diagnose(scope: string, input: Record<string, unknown>): Promise<TranslationReply> {
    const probe = connectionProbe(input.connection);
    if (input.action === 'testConnection') string(probe.model, 160);
    const connection = this.vault.resolveConnection(scope, probe);
    const options = { connection, fetcher: this.fetcher };
    const reply: TranslationReply = input.action === 'listModels'
      ? { ok: true, models: await listModels(options) }
      : { ok: true, test: await testConnection(options) };
    this.vault.read(scope); // Recheck account existence after a remote call; do not resurrect deleted accounts.
    return reply;
  }
  private authorizeTranslation(scope: string, input: Record<string, unknown>) {
    string(input.text, MAX_TEXT_LENGTH);
    if (typeof input.automatic !== 'boolean') throw new TranslationError('invalid-input');
    const data = this.vault.read(scope);
    if (input.revision !== data.revision) throw new TranslationError('stale-settings');
    const { preferences } = data;
    if (!preferences.consent) throw new TranslationError('consent-required');
    if (input.automatic && !preferences.automatic) throw new TranslationError('stale-settings');
    return data;
  }
  private selectedProvider(data: ReturnType<TranslationVault['read']>) {
    const engine = data.preferences.engine ?? data.preferences.defaultConnection;
    const connection = data.connections.find((c) => c.id === engine);
    if (!engine || (!connection && !ANONYMOUS_ENGINES.includes(engine)))
      throw new TranslationError('missing-connection');
    return { engine, connection };
  }
  private async translate(scope: string, input: Record<string, unknown>): Promise<TranslationReply> {
    const data = this.authorizeTranslation(scope, input);
    const { preferences } = data;
    const skipped = translationEligibility(input.text as string, preferences.targetLanguage);
    if (skipped) return { ok: true, result: skipped };
    const { engine, connection } = this.selectedProvider(data);
    const key = translationResultKey({
      text: input.text as string,
      target: preferences.targetLanguage,
      engine,
      connection,
    });
    const cached = this.cache.get(scope, key);
    if (cached !== null) return { ok: true, result: { kind: 'translated', text: cached } };
    let active = this.active.get(scope);
    if (active && active.key !== key) throw new TranslationError('busy');
    if (!active) {
      const result = this.requestTranslation({
        scope,
        key,
        text: input.text as string,
        target: preferences.targetLanguage,
        engine,
        connection,
      });
      active = { key, result };
      this.active.set(scope, active);
    }
    try {
      // Duplicate callers share one billable request; each caller still checks its own authorization revision.
      const text = await active.result;
      this.authorizeTranslation(scope, input);
      return { ok: true, result: { kind: 'translated', text } };
    } finally {
      if (this.active.get(scope) === active) this.active.delete(scope);
    }
  }
  private async requestTranslation(input: {
    scope: string;
    key: string;
    text: string;
    target: TranslationLanguage;
    engine: string;
    connection?: StoredConnection;
  }): Promise<string> {
    const prepared = protectText(input.text);
    const options = { text: prepared.text, target: input.target, fetcher: this.fetcher };
    const output = input.connection
      ? await translateAi({ ...options, connection: input.connection })
      : await translateAnonymous({ ...options, engine: input.engine });
    const text = restoreText(output, prepared);
    // Save validated work even if presentation/revision changed while waiting, but never after consent withdrawal.
    if (this.vault.read(input.scope).preferences.consent) this.cache.set(input.scope, input.key, text);
    return text;
  }
}

/** No stack, URL, provider body or source content crosses the IPC/HTTP error boundary. */
function commandFailure(error: unknown): TranslationReply {
  const safe = error instanceof TranslationError ? error : new TranslationError('invalid-response');
  return {
    ok: false,
    code: safe.code,
    ...(safe.status === undefined ? {} : { status: safe.status }),
  };
}
