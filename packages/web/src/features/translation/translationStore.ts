import { serverTranslationBridge } from './serverBridge';
import { create } from 'zustand';
import { useAuthStore } from '../../stores/authStore';
import type {
  TranslationCommand,
  TranslationReply,
  TranslationResult,
  TranslationSettings,
} from '@backspace/shared/translation';

type Failure = Extract<TranslationReply, { ok: false }>;
export type TranslationEntry =
  | { state: 'loading' }
  | { state: 'done'; result: TranslationResult; automatic: boolean }
  | { state: 'error'; error: Failure };
interface TranslationState {
  scope: string;
  settings: TranslationSettings | null;
  loadError: Failure | null;
  automaticError: Failure | null;
  entries: Record<string, TranslationEntry>;
  generation: number;
  trackedMessages: Record<string, true>;
}
export const useTranslationStore = create<TranslationState>(() => ({
  scope: '',
  settings: null,
  loadError: null,
  automaticError: null,
  entries: {},
  generation: 0,
  trackedMessages: {},
}));
// Backend selection is by client capability, never an error-triggered fallback. Native secrets stay local.
export const translationBridge = () => window.backspace?.translation ?? serverTranslationBridge;
let loading: Promise<void> | null = null;
let running = false;
let scopeEpoch = 0;
const CACHE_LIMIT = 200;
const TRACKED_MESSAGE_LIMIT = 1000;
interface Task {
  key: string;
  scope: string;
  accountId: string;
  text: string;
  automatic: boolean;
  /** Background refresh follows a prior single-message choice, even with global auto off. */
  background: boolean;
  revision: number;
  scopeEpoch: number;
}
let queue: Task[] = [];

export async function sendTranslationCommand(command: TranslationCommand): Promise<TranslationReply> {
  try {
    const bridge = translationBridge();
    return await bridge.command(command);
  } catch {
    return { ok: false, code: 'network' };
  }
}
export function resetTranslationScope(scope: string): void {
  queue = [];
  loading = null;
  scopeEpoch += 1;
  useTranslationStore.setState((state) => ({
    scope,
    settings: null,
    loadError: null,
    automaticError: null,
    entries: {},
    generation: state.generation + 1,
    trackedMessages: {},
  }));
}
export async function loadTranslationSettings(input: {
  scope: string;
  accountId: string;
  reload?: boolean;
}): Promise<void> {
  if (useTranslationStore.getState().scope !== input.scope) resetTranslationScope(input.scope);
  const state = useTranslationStore.getState();
  if (!input.reload && (state.settings || state.loadError)) return;
  if (loading) return loading;
  const epoch = scopeEpoch;
  loading = (async () => {
    const reply = await sendTranslationCommand({
      action: 'load',
      accountId: input.accountId,
    });
    if (scopeEpoch !== epoch) return;
    if (reply.ok && 'settings' in reply) acceptTranslationSettings(reply.settings);
    if (!reply.ok) useTranslationStore.setState({ loadError: reply });
  })();
  const current = loading;
  await current;
  if (loading === current) loading = null;
}
function configurationKey(settings: TranslationSettings | null): string {
  if (!settings) return '';
  const { preferences } = settings;
  const engine = preferences.engine ?? preferences.defaultConnection;
  const connection = settings.connections.find((item) => item.id === engine);
  const provider = connection ? [connection.protocol, connection.baseUrl, connection.model] : engine;
  return JSON.stringify([provider, preferences.targetLanguage, preferences.consent]);
}
export function acceptTranslationSettings(settings: TranslationSettings): void {
  queue = [];
  const state = useTranslationStore.getState();
  const invalidate = configurationKey(state.settings) !== configurationKey(settings);
  // Key rotation, renaming and unrelated connection edits do not invalidate completed translations.
  const entries = invalidate
    ? {}
    : Object.fromEntries(Object.entries(state.entries).filter(([, entry]) => entry.state === 'done'));
  useTranslationStore.setState({
    settings,
    loadError: null,
    entries,
    trackedMessages: settings.preferences.consent ? state.trackedMessages : {},
    automaticError: null,
    generation: state.generation + (invalidate ? 1 : 0),
  });
}
/** Track translation intent separately from body versions so edits do not lose a manual choice. */
export function trackTranslatedMessage(identity: string): void {
  const previous = useTranslationStore.getState().trackedMessages;
  if (previous[identity]) return;
  const trackedMessages: Record<string, true> = { ...previous, [identity]: true };
  const identities = Object.keys(trackedMessages);
  if (identities.length > TRACKED_MESSAGE_LIMIT) delete trackedMessages[identities[0]!];
  useTranslationStore.setState({ trackedMessages });
}
function setEntry(key: string, entry: TranslationEntry): void {
  const entries = { ...useTranslationStore.getState().entries, [key]: entry };
  const keys = Object.keys(entries);
  if (keys.length > CACHE_LIMIT) delete entries[keys[0]!];
  useTranslationStore.setState({ entries });
}
function isCurrent(task: Task): boolean {
  const state = useTranslationStore.getState();
  return (
    task.scopeEpoch === scopeEpoch && state.scope === task.scope && state.settings?.revision === task.revision
  );
}
function canRun(task: Task): boolean {
  if (!isCurrent(task)) return false;
  if (!task.background) return true;
  const state = useTranslationStore.getState();
  return (
    (!task.automatic || !!state.settings?.preferences.automatic) &&
    !state.automaticError &&
    document.visibilityState === 'visible'
  );
}
async function pump(): Promise<void> {
  if (running) return;
  let task = queue.shift();
  while (task && !canRun(task)) task = queue.shift();
  if (!task) return;
  running = true;
  setEntry(task.key, { state: 'loading' });
  const reply = await sendTranslationCommand({
    action: 'translate',
    accountId: task.accountId,
    text: task.text,
    revision: task.revision,
    automatic: task.automatic,
  });
  if (isCurrent(task)) {
    if (reply.ok && 'result' in reply)
      setEntry(task.key, {
        state: 'done',
        result: reply.result,
        automatic: task.automatic,
      });
    if (!reply.ok) {
      setEntry(task.key, { state: 'error', error: reply });
      // Pause the session after an automatic failure. Never retry or move to another provider implicitly.
      if (task.background) useTranslationStore.setState({ automaticError: reply });
    }
  }
  running = false;
  void pump();
}
export function enqueueTranslation(
  input: Omit<Task, 'scopeEpoch' | 'background'> & { background?: boolean },
): () => void {
  const task: Task = { ...input, background: input.background ?? input.automatic, scopeEpoch };
  const entry = useTranslationStore.getState().entries[task.key];
  if ((entry && entry.state !== 'error') || queue.some((item) => item.key === task.key)) return () => {};
  if (task.background && entry?.state === 'error') return () => {};
  if (task.background) queue.push(task);
  else queue.unshift(task);
  void pump();
  // IntersectionObserver cleanup removes unsent tasks; already-sent text cannot be retracted.
  return () => {
    queue = queue.filter((item) => item !== task);
  };
}
export function resumeAutomaticTranslation(): void {
  const entries = Object.fromEntries(
    Object.entries(useTranslationStore.getState().entries).filter(([, entry]) => entry.state !== 'error'),
  );
  useTranslationStore.setState({ automaticError: null, entries });
}

// Clear translated message content immediately at account boundaries, even if no message rows remain mounted.
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) resetTranslationScope('');
});
