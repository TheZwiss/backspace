import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FederationRegistryEntry } from '@backspace/shared';
import { useInstanceStore } from '../../stores/instanceStore';
import { ReauthForm } from '../modals/ReauthForm';

/** The two registry states the row shows; `disconnected` is the user's own choice and is left out. */
type AttentionStatus = 'auth_expired' | 'unreachable';

interface AttentionEntry extends FederationRegistryEntry {
  status: AttentionStatus;
}

function needsAttention(entry: FederationRegistryEntry): entry is AttentionEntry {
  return entry.status === 'auth_expired' || entry.status === 'unreachable';
}

function safeHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

interface ConnectionChipsProps {
  /** Called after a connection is back, so the page can refetch what depends on it. */
  onRecovered: () => void;
}

/**
 * The Explore page's hint for connections that are out: one quiet chip per
 * registry entry whose status is `auth_expired` or `unreachable`, read from
 * the same federation registry the Connections panel shows so the two never
 * disagree. Inner Space only fans out over `connected` instances and Outer
 * Space drops every origin the session knows, so without this row an expired
 * session makes an instance's spaces vanish from both with no explanation.
 *
 * With every connection healthy the component renders nothing. A chip whose
 * live instance is `connecting` on its own (startup, the socket's backoff) is
 * hidden for that moment; a chip whose Retry is in flight stays and shows the
 * connecting word instead, until the registry status settles.
 */
export function ConnectionChips({ onRecovered }: ConnectionChipsProps) {
  const { t } = useTranslation(['spaces']);
  const registry = useInstanceStore((s) => s.registry);
  const instances = useInstanceStore((s) => s.instances);
  const reconnectInstance = useInstanceStore((s) => s.reconnectInstance);

  // Origins whose Retry this row started and has not seen finish.
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());

  const entries = useMemo(() => {
    const out: AttentionEntry[] = [];
    for (const entry of registry.values()) {
      if (!needsAttention(entry)) continue;
      const live = instances.find((i) => i.origin === entry.origin);
      if (live?.status === 'connecting' && !retrying.has(entry.origin)) continue;
      out.push(entry);
    }
    return out;
  }, [registry, instances, retrying]);

  // reconnectInstance returns at once when there is neither a live instance
  // nor a cached token for the origin (reachable only after a force-remove
  // race); the chip then simply returns to Retry, the same no-op the
  // Connections row has for that state.
  const handleRetry = useCallback(async (origin: string) => {
    setRetrying((prev) => new Set(prev).add(origin));
    try {
      await reconnectInstance(origin);
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(origin);
        return next;
      });
    }
    if (useInstanceStore.getState().registry.get(origin)?.status === 'connected') onRecovered();
  }, [reconnectInstance, onRecovered]);

  if (entries.length === 0) return null;

  return (
    <ul
      className="flex flex-wrap items-center gap-2 mb-4"
      aria-label={t('spaces:explore.connections.title')}
    >
      {entries.map((entry) => (
        <ConnectionChip
          key={entry.origin}
          entry={entry}
          retrying={retrying.has(entry.origin)}
          onRetry={handleRetry}
          onRecovered={onRecovered}
        />
      ))}
    </ul>
  );
}

interface ConnectionChipProps {
  entry: AttentionEntry;
  retrying: boolean;
  onRetry: (origin: string) => void;
  onRecovered: () => void;
}

/**
 * Who this chip is about and what is wrong with it: the state dot, the
 * instance, then the state word. One line in both states, and the same line
 * in both, so opening the chip does not move what the eye is already on.
 */
function ChipIdentity({ label, stateWord, expired, dimmed }: {
  label: string;
  stateWord: string;
  expired: boolean;
  dimmed: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${expired ? 'bg-accent-rose' : 'bg-accent-amber'}`}
      />
      <span className={`truncate transition-opacity ${dimmed ? 'text-txt-tertiary' : 'text-txt-secondary'}`}>
        {label}
      </span>
      <span aria-hidden="true" className="text-txt-tertiary/60">·</span>
      <span className="text-txt-tertiary whitespace-nowrap">{stateWord}</span>
    </span>
  );
}

/**
 * One connection that needs attention, in one of two shapes.
 *
 * Collapsed it is a `glass-pill`: the identity line and a one-word action,
 * sized by its own text and sharing the row with its siblings.
 *
 * Expanded it is not a pill any more, because a pill that holds a form is
 * only a stretched pill. It becomes a small matte panel on a line of its
 * own: the identity line unchanged at the top, the re-authentication form
 * under it, and a width bounded by the form rather than by the section, so
 * the field never runs the width of the page and the error under it lines
 * up with the field instead of floating in the middle of a wide surface.
 * The page's cards move by the panel's own height and nothing else.
 *
 * Escape and Cancel both collapse it and hand focus back to the action that
 * opened it, so the keyboard never lands on the document body.
 */
function ConnectionChip({ entry, retrying, onRetry, onRecovered }: ConnectionChipProps) {
  const { t } = useTranslation(['spaces', 'federation']);
  const [expanded, setExpanded] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);

  const expired = entry.status === 'auth_expired';
  const label = entry.label || safeHost(entry.origin);
  const stateWord = expired
    ? t('spaces:explore.connections.sessionExpired')
    : t('spaces:explore.connections.unreachable');

  // The action only exists again once the form is gone, so the focus move
  // waits for the render that brings it back.
  useEffect(() => {
    if (expanded || !restoreFocus) return;
    setRestoreFocus(false);
    actionRef.current?.focus();
  }, [expanded, restoreFocus]);

  const handleCollapse = () => {
    setRestoreFocus(true);
    setExpanded(false);
  };

  // Success normally takes the chip off the row entirely (the registry now
  // reads `connected`), and the focus request then finds nothing to move to.
  // It is made anyway so a session that comes back without the registry
  // having caught up still leaves the keyboard on the chip.
  const handleDone = () => {
    handleCollapse();
    onRecovered();
  };

  // The visible action is one word; assistive tech gets the instance too, so
  // two chips do not both read as "Reconnect, button".
  const reconnectWord = t('spaces:explore.connections.reconnect');
  const retryWord = retrying ? t('federation:connections.add.connecting') : t('spaces:explore.connections.retry');

  if (expired && expanded) {
    return (
      <li className="w-full">
        <div className="w-full max-w-[22rem] p-3 rounded-xl bg-surface-elevated border border-white/[0.06] shadow-elevation-low space-y-2.5">
          <div className="text-[13px] leading-5">
            <ChipIdentity label={label} stateWord={stateWord} expired dimmed={false} />
          </div>
          <ReauthForm
            origin={entry.origin}
            username={entry.username}
            onDone={handleDone}
            onCancel={handleCollapse}
          />
        </div>
      </li>
    );
  }

  return (
    <li className="glass-pill text-[13px] leading-5 rounded-full pl-2.5 pr-3 py-1 inline-flex items-center gap-2 max-w-full">
      <ChipIdentity label={label} stateWord={stateWord} expired={expired} dimmed={retrying} />
      {expired ? (
        <button
          ref={actionRef}
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`${reconnectWord} ${label}`}
          className="ml-1 text-accent-primary hover:text-accent-primary/80 font-medium transition-colors whitespace-nowrap"
        >
          {reconnectWord}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onRetry(entry.origin)}
          disabled={retrying}
          aria-label={`${retryWord} ${label}`}
          className="ml-1 text-accent-primary hover:text-accent-primary/80 font-medium transition-colors whitespace-nowrap disabled:text-txt-tertiary disabled:cursor-default"
        >
          {retryWord}
        </button>
      )}
    </li>
  );
}
