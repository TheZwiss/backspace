/** Private translation commands: native IPC or authenticated home-instance HTTP, never federation. */
export type TranslationProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
export type TranslationEngine = string;
export type TranslationLanguage =
  | 'zh-CN'
  | 'zh-TW'
  | 'en'
  | 'ja'
  | 'ko'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt'
  | 'ru'
  | 'ar';
export interface AiConnection {
  id: string;
  name: string;
  protocol: TranslationProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export interface TranslationPreferences {
  defaultConnection: string | null;
  /** null inherits the global AI connection; anonymous services are explicit choices. */
  engine: TranslationEngine | null;
  targetLanguage: TranslationLanguage;
  automatic: boolean;
  showOriginal: boolean;
  consent: boolean;
}
export interface TranslationSettings {
  revision: number;
  connections: AiConnection[];
  preferences: TranslationPreferences;
}
export type ConnectionInput = Omit<AiConnection, 'id' | 'hasKey'> & {
  id?: string;
  apiKey?: string;
};
/** Unsaved connection diagnostics; an omitted key may reuse only the same saved recipient. */
export type ConnectionProbe = Omit<ConnectionInput, 'name' | 'model'> & { model?: string };
export type TranslationCommand =
  | { action: 'load'; accountId: string }
  | { action: 'saveConnection'; accountId: string; connection: ConnectionInput }
  | { action: 'listModels' | 'testConnection'; accountId: string; connection: ConnectionProbe }
  | { action: 'deleteConnection'; accountId: string; id: string }
  | {
      action: 'savePreferences';
      accountId: string;
      preferences: TranslationPreferences;
    }
  | {
      action: 'translate';
      accountId: string;
      text: string;
      revision: number;
      automatic: boolean;
    };
export type TranslationResult =
  | { kind: 'translated'; text: string }
  | {
      kind: 'skipped';
      reason: 'same-language' | 'not-text' | 'uncertain-language';
    };
export type TranslationErrorCode =
  | 'server-not-configured'
  | 'unsafe-endpoint'
  | 'insecure-transport'
  | 'invalid-input'
  | 'untrusted-sender'
  | 'secure-storage'
  | 'storage'
  | 'cache-storage'
  | 'missing-connection'
  | 'consent-required'
  | 'stale-settings'
  | 'busy'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid-response'
  | 'protected-content'
  | 'anonymous-unavailable';
export type TranslationReply =
  | { ok: true; settings: TranslationSettings }
  | { ok: true; result: TranslationResult }
  | { ok: true; models: string[] }
  | { ok: true; test: { latencyMs: number; text: string } }
  | { ok: false; code: TranslationErrorCode; status?: number };
export interface TranslationBridge {
  command(command: TranslationCommand): Promise<TranslationReply>;
}
