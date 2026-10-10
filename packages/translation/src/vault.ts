import { randomUUID } from 'crypto';
import type {
  AiConnection,
  ConnectionInput,
  ConnectionProbe,
  TranslationPreferences,
  TranslationSettings,
} from '../../shared/src/translation';
import { ANONYMOUS_ENGINES, TranslationError, connectionInput, preferencesInput, record } from './validation';

export interface StoredConnection extends Omit<AiConnection, 'hasKey'> {
  apiKey: string;
}
interface VaultData {
  version: 1;
  revision: number;
  connections: StoredConnection[];
  preferences: TranslationPreferences;
}
/** Adapters must encrypt persisted data; plaintext exists only in process memory. */
export interface VaultStorage {
  read(scope: string): string | null;
  write(scope: string, plaintext: string): void;
}
export const DEFAULT_PREFERENCES: TranslationPreferences = {
  defaultConnection: null,
  engine: null,
  targetLanguage: 'en',
  automatic: false,
  showOriginal: true,
  consent: false,
};

function prepareConnection(input: ConnectionInput, previous: StoredConnection | undefined): StoredConnection {
  if (!previous) return { ...input, id: randomUUID(), apiKey: input.apiKey ?? '' };
  // Editing an endpoint/protocol cannot silently forward the old secret to a new recipient.
  const sameRecipient = previous.baseUrl === input.baseUrl && previous.protocol === input.protocol;
  if (previous.apiKey && !sameRecipient && input.apiKey === undefined)
    throw new TranslationError('invalid-input');
  return { ...input, id: previous.id, apiKey: input.apiKey ?? previous.apiKey };
}

/** Account-scoped settings and key-redacted snapshots, independent of storage location. */
export class TranslationVault {
  constructor(private readonly storage: VaultStorage) {}
  read(scope: string): VaultData {
    const plaintext = this.storage.read(scope);
    if (plaintext === null)
      return {
        version: 1,
        revision: 0,
        connections: [],
        preferences: { ...DEFAULT_PREFERENCES },
      };
    try {
      const value = record(JSON.parse(plaintext));
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.connections))
        throw new Error('schema');
      const connections = value.connections.map((raw) => {
        const input = connectionInput(raw);
        if (!input.id || typeof input.apiKey !== 'string') throw new Error('schema');
        return { ...input, id: input.id, apiKey: input.apiKey };
      });
      return {
        version: 1,
        revision: value.revision as number,
        connections,
        preferences: preferencesInput(value.preferences),
      };
    } catch (error) {
      if (error instanceof TranslationError && error.code === 'secure-storage') throw error;
      throw new TranslationError('storage');
    }
  }
  private write(scope: string, value: VaultData): TranslationSettings {
    this.storage.write(scope, JSON.stringify({ ...value, revision: value.revision + 1 }));
    return this.snapshot(scope);
  }
  snapshot(scope: string): TranslationSettings {
    const data = this.read(scope);
    return {
      revision: data.revision,
      preferences: data.preferences,
      connections: data.connections.map(({ apiKey, ...connection }) => ({
        ...connection,
        hasKey: !!apiKey,
      })),
    };
  }
  saveConnection(scope: string, input: ConnectionInput): TranslationSettings {
    const data = this.read(scope);
    const previous = data.connections.find((c) => c.id === input.id);
    if (input.id && !previous) throw new TranslationError('invalid-input');
    if (!previous && data.connections.length >= 20) throw new TranslationError('invalid-input');
    const connection = prepareConnection(input, previous);
    const connections = [...data.connections.filter((c) => c.id !== connection.id), connection];
    const preferences = {
      ...data.preferences,
      defaultConnection: data.preferences.defaultConnection ?? connection.id,
    };
    return this.write(scope, { ...data, connections, preferences });
  }
  resolveConnection(scope: string, input: ConnectionProbe): StoredConnection {
    const previous = this.read(scope).connections.find(c => c.id === input.id);
    if (input.id && !previous) throw new TranslationError('missing-connection');
    // Diagnostics follow the same recipient boundary as saving; they never persist an edited secret.
    return prepareConnection({ ...input, name: previous?.name ?? 'Connection test', model: input.model ?? '' }, previous);
  }
  deleteConnection(scope: string, id: string): TranslationSettings {
    const data = this.read(scope);
    const preferences = { ...data.preferences, automatic: false };
    if (preferences.defaultConnection === id) preferences.defaultConnection = null;
    if (preferences.engine === id) preferences.engine = null;
    return this.write(scope, {
      ...data,
      connections: data.connections.filter((c) => c.id !== id),
      preferences,
    });
  }
  savePreferences(scope: string, preferences: TranslationPreferences): TranslationSettings {
    const data = this.read(scope);
    const ids = data.connections.map((c) => c.id);
    if (preferences.defaultConnection !== null && !ids.includes(preferences.defaultConnection))
      throw new TranslationError('missing-connection');
    if (preferences.engine !== null && ![...ids, ...ANONYMOUS_ENGINES].includes(preferences.engine))
      throw new TranslationError('missing-connection');
    if (preferences.automatic && !preferences.consent) throw new TranslationError('consent-required');
    if (preferences.automatic && !(preferences.engine ?? preferences.defaultConnection))
      throw new TranslationError('missing-connection');
    return this.write(scope, { ...data, preferences });
  }
}
