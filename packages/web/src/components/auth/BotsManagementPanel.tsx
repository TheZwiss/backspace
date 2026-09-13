import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Bot, BotScope, BotTokenListItem, BotTokenMintResponse } from '@backspace/shared';
import { BOT_SCOPES } from '@backspace/shared';

/**
 * Bots management UI (issue #184). Lives inside the Account tab of the
 * UserSettings modal. Humans only — federated accounts see a notice instead.
 *
 * Key UX rules:
 *   - Token plaintext is displayed ONCE after mint. A "copy" button is shown
 *     alongside; the user is told to save it somewhere secure.
 *   - The token row hides the plaintext once the user dismisses the dialog.
 *     Subsequent list calls only show the masked preview.
 *   - Revoke + rotate are owner-confirmed (irreversible).
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'create' }
  | { kind: 'tokens'; bot: Bot }
  | { kind: 'new-token'; bot: Bot; minted: BotTokenMintResponse };

export function BotsManagementPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [tokens, setTokens] = useState<BotTokenListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create form
  const [displayName, setDisplayName] = useState('');
  const [botDisplayTag, setBotDisplayTag] = useState('');
  const [initialScopes, setInitialScopes] = useState<Set<BotScope>>(new Set());

  // New token form
  const [mintLabel, setMintLabel] = useState('');
  const [mintScopes, setMintScopes] = useState<Set<BotScope>>(new Set());

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { bots: list } = await api.bots.list();
      setBots(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bots');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const beginCreate = () => {
    setError(null);
    setDisplayName('');
    setBotDisplayTag('');
    setInitialScopes(new Set());
    setPhase({ kind: 'create' });
  };

  const submitCreate = async () => {
    setError(null);
    if (!displayName.trim()) { setError('Display name is required'); return; }
    setBusy(true);
    try {
      const r = await api.bots.create({
        displayName: displayName.trim(),
        botDisplayTag: botDisplayTag.trim() || undefined,
        scopes: [...initialScopes],
      });
      setPhase({ kind: 'new-token', bot: r.bot, minted: r.initialToken });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bot');
    } finally {
      setBusy(false);
    }
  };

  const openTokens = async (bot: Bot) => {
    setError(null);
    setPhase({ kind: 'tokens', bot });
    setBusy(true);
    try {
      const r = await api.bots.listTokens(bot.id);
      setTokens(r.tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tokens');
    } finally {
      setBusy(false);
    }
  };

  const refreshTokens = async (bot: Bot) => {
    const r = await api.bots.listTokens(bot.id);
    setTokens(r.tokens);
  };

  const beginMint = () => {
    setMintLabel('');
    setMintScopes(new Set());
  };

  const submitMint = async (bot: Bot) => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.bots.mintToken(bot.id, { label: mintLabel.trim() || undefined, scopes: [...mintScopes] });
      setPhase({ kind: 'new-token', bot, minted: r });
      await refreshTokens(bot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint token');
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (bot: Bot, tokenId: string) => {
    if (!confirm('Revoke this token? Any client using it will be disconnected immediately. This cannot be undone.')) return;
    setError(null);
    setBusy(true);
    try {
      await api.bots.revokeToken(bot.id, tokenId);
      await refreshTokens(bot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async (bot: Bot, tokenId: string) => {
    if (!confirm('Rotate this token? The old token will be revoked and a new one minted. The new plaintext will be shown ONCE.')) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.bots.rotateToken(bot.id, tokenId);
      setPhase({ kind: 'new-token', bot, minted: r });
      await refreshTokens(bot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate token');
    } finally {
      setBusy(false);
    }
  };

  const dismissNewToken = () => {
    if (phase.kind === 'new-token') setPhase({ kind: 'tokens', bot: phase.bot });
  };

  const cancelBack = () => {
    setPhase({ kind: 'idle' });
    setError(null);
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  if (phase.kind === 'new-token') {
    return <NewTokenView minted={phase.minted} bot={phase.bot} onDone={dismissNewToken} />;
  }

  if (phase.kind === 'create') {
    return (
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-txt-primary">Create bot</h3>
        {error && <ErrorBox>{error}</ErrorBox>}
        <label className="block text-xs font-bold text-txt-secondary uppercase">Display name *</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="OpenClaw worker"
          className="input-standard w-full py-2"
          autoFocus
        />
        <label className="block text-xs font-bold text-txt-secondary uppercase mt-2">Bot tag (optional)</label>
        <input
          type="text"
          value={botDisplayTag}
          onChange={(e) => setBotDisplayTag(e.target.value)}
          placeholder="e.g. @openclaw"
          className="input-standard w-full py-2"
        />
        <ScopePicker
          selected={initialScopes}
          onChange={setInitialScopes}
          label="Initial scopes"
        />
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={submitCreate} disabled={busy} className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded disabled:opacity-50">
            {busy ? 'Creating...' : 'Create bot'}
          </button>
          <button type="button" onClick={cancelBack} className="px-4 py-2 text-txt-tertiary hover:text-txt-secondary text-sm rounded">
            Cancel
          </button>
        </div>
        <p className="text-xs text-txt-tertiary mt-2">
          Bots cannot log in with a password. They authenticate via API tokens you mint below.
          Bot creation is only available on native or detached accounts (not on federated homes).
        </p>
      </div>
    );
  }

  if (phase.kind === 'tokens') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-txt-primary">Tokens for {phase.bot.displayName ?? phase.bot.username}</h3>
            <p className="text-xs text-txt-tertiary">{phase.bot.username}</p>
          </div>
          <button type="button" onClick={cancelBack} className="text-sm text-txt-tertiary hover:text-txt-secondary">
            ← Back
          </button>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}

        {/* Mint new token */}
        <div className="p-3 bg-surface-input rounded">
          <h4 className="text-sm font-medium text-txt-primary mb-2">Mint a new API token</h4>
          <label className="block text-xs font-bold text-txt-secondary uppercase">Label</label>
          <input type="text" value={mintLabel} onChange={(e) => setMintLabel(e.target.value)} placeholder="e.g. ci-worker" className="input-standard w-full py-2 mb-2" />
          <ScopePicker selected={mintScopes} onChange={setMintScopes} label="Scopes" />
          <button type="button" onClick={() => beginMint()} className="hidden" aria-hidden />
          <button type="button" onClick={() => submitMint(phase.bot)} disabled={busy} className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded disabled:opacity-50">
            Mint token
          </button>
          <p className="text-xs text-txt-tertiary mt-2">
            The token plaintext is shown ONCE. Save it now — there is no way to retrieve it later.
          </p>
        </div>

        {/* Token list */}
        <div>
          <h4 className="text-sm font-medium text-txt-primary mb-2">Existing tokens</h4>
          {tokens === null && <p className="text-sm text-txt-tertiary">Loading...</p>}
          {tokens && tokens.length === 0 && <p className="text-sm text-txt-tertiary">No tokens yet.</p>}
          {tokens && tokens.length > 0 && (
            <div className="space-y-2">
              {tokens.map((t) => (
                <div key={t.id} className={`p-3 rounded border ${t.revokedAt ? 'bg-surface-input/50 border-white/[0.04] opacity-60' : 'bg-surface-input border-white/[0.08]'}`}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-txt-primary">{t.tokenPreview}</div>
                      {t.label && <div className="text-xs text-txt-tertiary mt-0.5">{t.label}</div>}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {t.scopes.map((s) => (
                          <span key={s} className="text-[10px] px-1.5 py-0.5 bg-accent-primary/20 text-accent-primary rounded font-mono">{s}</span>
                        ))}
                      </div>
                      <div className="text-xs text-txt-tertiary mt-1">
                        created {new Date(t.createdAt).toISOString().slice(0, 10)}
                        {t.lastUsedAt && ` • last used ${new Date(t.lastUsedAt).toISOString().slice(0, 10)}`}
                        {t.revokedAt && ` • revoked ${new Date(t.revokedAt).toISOString().slice(0, 10)}${t.revokedReason ? ` (${t.revokedReason})` : ''}`}
                      </div>
                    </div>
                    {!t.revokedAt && (
                      <div className="flex flex-col gap-1 ml-3">
                        <button type="button" onClick={() => rotateToken(phase.bot, t.id)} className="text-xs px-2 py-1 bg-interactive-hover hover:bg-interactive-active text-txt-primary rounded">
                          Rotate
                        </button>
                        <button type="button" onClick={() => revokeToken(phase.bot, t.id)} className="text-xs px-2 py-1 bg-accent-rose/10 hover:bg-accent-rose/20 text-accent-rose rounded border border-accent-rose/30">
                          Revoke
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // idle: list bots
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt-primary">Bots & service accounts</h3>
        <button type="button" onClick={beginCreate} disabled={busy} className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded disabled:opacity-50">
          + New bot
        </button>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <p className="text-xs text-txt-tertiary">
        Bots are automation identities with explicit, server-enforced scopes. They authenticate via API
        tokens (never passwords) and are scoped to specific channels and actions.
      </p>
      {bots === null && <p className="text-sm text-txt-tertiary">Loading...</p>}
      {bots && bots.length === 0 && (
        <div className="p-4 bg-surface-input rounded text-center text-txt-tertiary">
          No bots yet. Click <strong className="text-txt-primary">+ New bot</strong> to create one.
        </div>
      )}
      {bots && bots.length > 0 && (
        <div className="space-y-2">
          {bots.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => openTokens(b)}
              className="w-full p-3 bg-surface-input hover:bg-interactive-hover rounded text-left flex items-center justify-between"
            >
              <div className="min-w-0">
                <div className="font-medium text-txt-primary truncate">
                  {b.displayName ?? b.username}
                  {b.botDisplayTag && <span className="ml-2 text-xs text-accent-primary font-mono">{b.botDisplayTag}</span>}
                </div>
                <div className="text-xs text-txt-tertiary truncate">{b.username}</div>
              </div>
              <div className="text-xs text-txt-tertiary">
                {b.isDeleted ? 'deleted' : 'active'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
      {children}
    </div>
  );
}

function ScopePicker({
  selected,
  onChange,
  label,
}: {
  selected: Set<BotScope>;
  onChange: (next: Set<BotScope>) => void;
  label: string;
}) {
  return (
    <div>
      <label className="block text-xs font-bold text-txt-secondary uppercase mb-1">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {BOT_SCOPES.map((s) => {
          const on = selected.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (on) next.delete(s); else next.add(s);
                onChange(next);
              }}
              className={`text-xs px-2 py-1 rounded font-mono border ${on ? 'bg-accent-primary/20 text-accent-primary border-accent-primary/50' : 'bg-surface-input text-txt-tertiary border-white/[0.06] hover:text-txt-primary'}`}
            >
              {on ? '✓ ' : ''}{s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NewTokenView({
  minted,
  bot,
  onDone,
}: {
  minted: BotTokenMintResponse;
  bot: Bot;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-txt-primary">Token minted for {bot.displayName ?? bot.username}</h3>
      <div className="p-3 bg-accent-amber/10 border border-accent-amber/30 rounded text-sm text-txt-primary">
        <strong className="font-semibold">Save this token now.</strong>{' '}
        It will NOT be shown again. Treat it like a password.
      </div>
      <div className="p-3 bg-surface-input rounded">
        <div className="font-mono text-sm break-all text-txt-primary">{minted.plaintext}</div>
        <div className="flex flex-wrap gap-1 mt-2">
          {minted.scopes.map((s) => (
            <span key={s} className="text-[10px] px-1.5 py-0.5 bg-accent-primary/20 text-accent-primary rounded font-mono">{s}</span>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(minted.plaintext);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="px-4 py-2 bg-interactive-hover hover:bg-interactive-active text-txt-primary text-sm font-medium rounded"
        >
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded"
        >
          I've saved the token
        </button>
      </div>
    </div>
  );
}
