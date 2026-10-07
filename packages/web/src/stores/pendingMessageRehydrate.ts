import { usePendingMessageStore, type PendingBubble } from './pendingMessageStore';
import { useTransferStore } from './transferStore';
import { useUIStore } from './uiStore';
import { getApiForOrigin, getChannelOrigin, getChannelKind, useSpaceStore } from './spaceStore';
import { HttpError, RateLimitError } from '../api/client';

let started = false;

/**
 * Whether every instance that could hold a bubble's channel has delivered its
 * ready: home, and every remote the auto-connect started, unless it is down.
 * From then on a channel no listing named is gone (deleted, hidden, or its
 * instance removed), so its bubble fails and the user can retry or discard it.
 */
let channelsSettled = false;
const readyOrigins = new Set<string>();
let remotes: { autoConnectDone: boolean; instances: ReadonlyArray<{ origin: string; status: string }> } | null = null;

/** The ready of `origin` has been applied to the stores (called by the WS ready handler). */
export function notePendingOriginReady(origin: string): void {
  readyOrigins.add(origin);
  recheckSettled();
}

function recheckSettled(): void {
  if (
    !channelsSettled
    && readyOrigins.has('')
    && remotes?.autoConnectDone === true
    && remotes.instances.every((i) => readyOrigins.has(i.origin) || i.status === 'disconnected' || i.status === 'error')
  ) {
    channelsSettled = true;
  }
  if (started) dispatchReady();
}

/**
 * Dispatch every bubble that is ready and not dispatched yet. A bubble whose
 * channel the client does not know yet (no ready has listed it) waits: the
 * endpoint and the instance depend on what the channel is. It is dispatched
 * by the spaceStore subscription below once a listing or event names it, and
 * fails once every instance has delivered its ready without naming it.
 */
function dispatchReady(): void {
  for (const b of usePendingMessageStore.getState().listReadyForDeferredSend()) {
    if (sentClientIds.has(b.clientId)) continue;
    if (getChannelKind(b.channelId) === 'unknown') {
      if (channelsSettled) usePendingMessageStore.getState().markFailed(b.clientId);
      continue;
    }
    sentClientIds.add(b.clientId);
    void deferredSend(b);
  }
}

/** Call once at app start. Idempotent against StrictMode/HMR remounts. */
export function startPendingMessageOrchestrator(): void {
  if (started) return;
  started = true;

  // 1. TTL discard with toast
  const dropped = usePendingMessageStore.getState().discardExpired(Date.now());
  for (const b of dropped) {
    useUIStore.getState().addToast(
      `Couldn't send "${b.content || '(attachment-only)'}" — upload expired.`,
      'warning',
    );
  }

  // 2. All-transfers-already-complete branch (handles bubbles whose uploads
  //    finished while the tab was closed)
  dispatchReady();

  // 3. Subscribe: any time relevant transfer state changes, re-check ready
  //    bubbles. Dedup by a (id|state|attachmentId) signature so we don't
  //    re-run on every progress tick. `sentClientIds` further dedups
  //    per-bubble dispatch.
  let lastStateSig = '';
  useTransferStore.subscribe((s) => {
    const sig = Array.from(s.transfers.values())
      .map((t) => `${t.id}|${t.state}|${t.attachmentId ?? ''}`)
      .sort()
      .join(',');
    if (sig === lastStateSig) return;
    lastStateSig = sig;

    // Mark bubbles as 'failed' when any of their transfers are in a terminal-failure
    // state (aborted or failed). This surfaces the retry/discard row in Message.tsx
    // instead of leaving the bubble stuck in 'sending' forever.
    const allTransfers = useTransferStore.getState().transfers;
    for (const list of usePendingMessageStore.getState().bubbles.values()) {
      for (const b of list) {
        if (b.state !== 'sending') continue;
        const anyBad = b.transferIds.some((tid) => {
          const t = allTransfers.get(tid);
          return t && (t.state === 'failed' || t.state === 'aborted');
        });
        if (anyBad) {
          usePendingMessageStore.getState().markFailed(b.clientId);
        }
      }
    }

    dispatchReady();
  });

  // 3b. Also re-check when pendingMessageStore mutates (e.g., new bubble appended
  //     AFTER boot, with all transfers already completed — eager-upload path).
  //     Without this, a bubble that becomes ready by virtue of pendingMessageStore
  //     changing — not transferStore — is never dispatched.
  let lastBubblesSig = '';
  usePendingMessageStore.subscribe((s) => {
    const sig = Array.from(s.bubbles.values())
      .flat()
      .map((b) => `${b.clientId}|${b.state}|${b.retryCount}`)
      .sort()
      .join(',');
    if (sig === lastBubblesSig) return;
    lastBubblesSig = sig;

    dispatchReady();
  });

  // 3c. Re-check when the client learns channels: a bubble restored at boot
  //     waits for the ready that lists its channel. The index and the DM list
  //     are replaced on every change, so a reference check is enough.
  let lastChannelIndex = useSpaceStore.getState().spaceChannelIndex;
  let lastDmChannels = useSpaceStore.getState().dmChannels;
  useSpaceStore.subscribe((s) => {
    if (s.spaceChannelIndex === lastChannelIndex && s.dmChannels === lastDmChannels) return;
    lastChannelIndex = s.spaceChannelIndex;
    lastDmChannels = s.dmChannels;
    dispatchReady();
  });

  // 3d. The remote instances, for `channelsSettled`. Imported lazily:
  //     instanceStore imports the WS layer, which reports readies here.
  void import('./instanceStore').then(({ useInstanceStore }) => {
    const read = (state: { _autoConnectDone: boolean; instances: ReadonlyArray<{ origin: string; status: string }> }): void => {
      remotes = { autoConnectDone: state._autoConnectDone, instances: state.instances };
      recheckSettled();
    };
    read(useInstanceStore.getState());
    useInstanceStore.subscribe(read);
  });

  // 4. Auto-retry on `online`: bump+resend bubbles that failed once with no
  //    prior retries (network-induced failure most likely). Uses the
  //    failed-retryable query — listReadyForDeferredSend gates state==='sending'
  //    and would never return failed bubbles.
  window.addEventListener('online', () => {
    const list = usePendingMessageStore.getState().listFailedRetryable();
    for (const b of list) {
      usePendingMessageStore.getState().bumpRetry(b.clientId);
      usePendingMessageStore.getState().markSending(b.clientId);
      // Add to dispatch set: the markSending transition could re-fire the
      // subscribe handler indirectly via downstream transferStore changes,
      // and we want only one in-flight send for this bubble.
      sentClientIds.add(b.clientId);
      void deferredSend(b, 1); // online auto-retry counts as the one allowed retry
    }
  });
}

const sentClientIds = new Set<string>();

async function deferredSend(b: PendingBubble, attempt = 0): Promise<void> {
  const transfers = useTransferStore.getState().transfers;
  const attachmentIds = b.transferIds
    .map((tid) => transfers.get(tid)?.attachmentId)
    .filter((id): id is string => Boolean(id));

  let client;
  let isDm: boolean;
  try {
    const origin = getChannelOrigin(b.channelId);
    client = getApiForOrigin(origin);
    isDm = getChannelKind(b.channelId) === 'dm';
  } catch (err) {
    console.warn('[pendingMessageRehydrate] origin resolution failed for', b.clientId, err);
    usePendingMessageStore.getState().markFailed(b.clientId);
    return;
  }

  try {
    if (isDm) {
      await client.dm.sendMessage(b.channelId, {
        content: b.content,
        attachments: attachmentIds,
        replyToId: b.replyToId ?? undefined,
      });
    } else {
      await client.channels.sendMessage(b.channelId, {
        content: b.content,
        attachments: attachmentIds,
        replyToId: b.replyToId ?? undefined,
      });
    }
    usePendingMessageStore.getState().removeByClientId(b.channelId, b.clientId);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 0;
    const isRateLimited = err instanceof RateLimitError;

    // 4xx (client error) and rate limits are permanent — mark failed,
    // user retries manually.
    if ((status >= 400 && status < 500) || isRateLimited) {
      usePendingMessageStore.getState().markFailed(b.clientId);
      return;
    }
    // Network error / 5xx: one immediate retry while online, then mark failed.
    if (attempt === 0 && navigator.onLine) {
      usePendingMessageStore.getState().bumpRetry(b.clientId);
      void deferredSend(b, 1);
      return;
    }
    usePendingMessageStore.getState().markFailed(b.clientId);
  }
}
