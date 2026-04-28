import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InviteLinkSummary } from '@backspace/shared';
import { api } from '../../../api/client';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';

interface RegistrationDraft {
  registrationOpen: boolean;
  federatedRegistrationOpen: boolean;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(diff / 60_000);
  if (mins >= 1) return `${mins}m ago`;
  return 'just now';
}

function formatExpiry(invite: InviteLinkSummary): string {
  if (invite.status === 'revoked' && invite.revokedAt) {
    return `Revoked ${new Date(invite.revokedAt).toLocaleDateString()}`;
  }
  if (invite.status === 'expired' && invite.expiresAt) {
    return `Expired ${new Date(invite.expiresAt).toLocaleDateString()}`;
  }
  if (invite.status === 'exhausted') {
    return 'Exhausted';
  }
  if (invite.expiresAt === null) return 'No expiration';
  const remaining = invite.expiresAt - Date.now();
  if (remaining <= 0) return `Expired ${new Date(invite.expiresAt).toLocaleDateString()}`;
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(remaining / 3_600_000);
  return `Expires in ${hours}h`;
}

interface InviteRowProps {
  invite: InviteLinkSummary;
  onMutate: () => void;
}

function InviteRow({ invite }: InviteRowProps) {
  const addToast = useUIStore((s) => s.addToast);

  const usageLabel =
    invite.maxUses === null
      ? `${invite.usedCount} use${invite.usedCount === 1 ? '' : 's'} · unlimited`
      : `${invite.usedCount} / ${invite.maxUses} uses`;

  const usageNearLimit =
    invite.maxUses !== null && invite.maxUses > 0 && invite.usedCount / invite.maxUses >= 0.8;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      addToast('Invite link copied', 'success', 2000);
    } catch {
      addToast('Failed to copy link', 'warning');
    }
  };

  const statusPillClass =
    invite.status === 'expired'
      ? 'bg-rose-500/20 text-rose-400'
      : invite.status === 'exhausted'
        ? 'bg-amber-500/20 text-amber-400'
        : 'bg-white/10 text-txt-tertiary';

  return (
    <div className="bg-white/[0.02] rounded-lg p-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-txt-primary truncate" title={invite.name}>
            {invite.name}
          </span>
          <span
            className={`text-xs ${usageNearLimit ? 'text-accent-amber' : 'text-txt-tertiary'}`}
          >
            · {usageLabel}
          </span>
          {invite.status !== 'active' && (
            <span
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusPillClass}`}
            >
              {invite.status}
            </span>
          )}
        </div>
        <div className="text-xs text-txt-tertiary mt-1">
          {formatExpiry(invite)} · Created by {invite.createdByUsername ?? 'Unknown'} ·{' '}
          {formatRelative(invite.createdAt)}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {invite.status === 'active' && (
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
          >
            Copy link
          </button>
        )}
      </div>
    </div>
  );
}

type ExpiryPresetId = '1h' | '24h' | '7d' | '30d' | 'never' | 'custom';

const EXPIRY_PRESETS: ReadonlyArray<{ id: ExpiryPresetId; label: string; ms: number | null }> = [
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '24h', label: '24 hours', ms: 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { id: 'never', label: 'Never', ms: null },
  // Custom uses a free-form datetime input rendered below the preset row;
  // ms is intentionally null and ignored for this id.
  { id: 'custom', label: 'Custom…', ms: null },
];

/**
 * Format a millisecond timestamp as a value suitable for `<input type="datetime-local">`.
 * The input expects local-wall-clock time in `YYYY-MM-DDTHH:mm` format (no timezone suffix);
 * the browser then interprets it in the user's local timezone on read-back via `new Date(value)`.
 */
function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface CreateInviteModalProps {
  onClose: () => void;
  onCreated: (created: InviteLinkSummary) => void;
}

function CreateInviteModal({ onClose, onCreated }: CreateInviteModalProps) {
  const addToast = useUIStore((s) => s.addToast);
  const [name, setName] = useState('');
  const [unlimited, setUnlimited] = useState(true);
  const [maxUses, setMaxUses] = useState('1');
  const [expiryId, setExpiryId] = useState<ExpiryPresetId>('7d');
  const [customDateTime, setCustomDateTime] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus name input on mount
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Escape closes the modal (capture phase so it fires before parent handlers)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onClose, submitting]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      addToast('Name must be 1–64 characters', 'warning');
      return;
    }
    let maxUsesNum: number | null = null;
    if (!unlimited) {
      const parsed = Number(maxUses);
      if (!Number.isInteger(parsed) || parsed < 1) {
        addToast('Max uses must be a positive integer', 'warning');
        return;
      }
      maxUsesNum = parsed;
    }

    // Resolve expiresAt from the preset selection. Custom requires a non-empty,
    // strictly-future datetime; everything else is derived from the preset's ms offset.
    let expiresAt: number | null;
    if (expiryId === 'never') {
      expiresAt = null;
    } else if (expiryId === 'custom') {
      if (customDateTime === '') {
        addToast('Pick a future date & time', 'warning');
        return;
      }
      const ts = new Date(customDateTime).getTime();
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        addToast('Pick a future date & time', 'warning');
        return;
      }
      expiresAt = ts;
    } else {
      const preset = EXPIRY_PRESETS.find((p) => p.id === expiryId);
      if (!preset || preset.ms === null) {
        // Unreachable: only 'never'/'custom' have null ms, and both are handled above.
        addToast('Invalid expiry selection', 'warning');
        return;
      }
      expiresAt = Date.now() + preset.ms;
    }

    setSubmitting(true);
    try {
      const created = await api.invites.create({ name: trimmed, maxUses: maxUsesNum, expiresAt });
      try {
        await navigator.clipboard.writeText(created.url);
        addToast('Link created. Copied to clipboard.', 'success', 2000);
      } catch {
        addToast('Link created. Copy manually from the row.', 'success', 2000);
      }
      onCreated(created);
      onClose();
    } catch (err) {
      addToast(`Failed to create invite: ${(err as Error).message}`, 'warning');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in"
      onClick={!submitting ? onClose : undefined}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Modal panel — stop propagation so backdrop click doesn't fire inside */}
      <div
        className="relative w-full max-w-md mx-4 glass-modal rounded-lg animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="p-6 space-y-5"
        >
          <h3 className="text-lg font-semibold text-txt-primary">Create invite link</h3>

          {/* Name */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="e.g. Friends batch 1"
              className="input-standard w-full"
              disabled={submitting}
            />
          </div>

          {/* Max uses */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">Max uses</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="maxUsesMode"
                  checked={unlimited}
                  onChange={() => setUnlimited(true)}
                  disabled={submitting}
                  className="accent-accent-primary"
                />
                <span className="text-txt-primary">Unlimited</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="maxUsesMode"
                  checked={!unlimited}
                  onChange={() => setUnlimited(false)}
                  disabled={submitting}
                  className="accent-accent-primary"
                />
                <input
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => {
                    setMaxUses(e.target.value);
                    setUnlimited(false);
                  }}
                  onClick={() => setUnlimited(false)}
                  disabled={submitting}
                  className="input-standard w-16 text-center disabled:opacity-50"
                />
                <span className="text-txt-secondary">uses</span>
              </label>
            </div>
          </div>

          {/* Expiry */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">Expires</label>
            <div className="flex items-center gap-2 flex-wrap">
              {EXPIRY_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setExpiryId(p.id)}
                  disabled={submitting}
                  className={`px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
                    expiryId === p.id
                      ? 'bg-accent-primary text-white'
                      : 'bg-surface-input text-txt-tertiary hover:text-txt-secondary'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {expiryId === 'custom' && (
              <input
                type="datetime-local"
                value={customDateTime}
                onChange={(e) => setCustomDateTime(e.target.value)}
                min={toDatetimeLocalValue(Date.now() + 60_000)}
                disabled={submitting}
                className="input-standard w-full px-3 py-2 text-sm mt-2"
              />
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function RegistrationPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<RegistrationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [invites, setInvites] = useState<InviteLinkSummary[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);

  // Tracks the currently displayed tab so in-flight fetches can detect when
  // the user has switched tabs and discard their stale response. Without this
  // guard, a slower 'archived' response can resolve after a newer 'active'
  // response and clobber the visible list. Used by both the auto-load effect
  // and manual fetchInvites() callers (e.g. post-mutation refresh).
  const tabRef = useRef<'active' | 'archived'>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  const fetchInvites = useCallback(
    async (which: 'active' | 'archived') => {
      setInvitesLoading(true);
      try {
        const res = await api.invites.list(which);
        if (tabRef.current !== which) return;
        setInvites(res.invites);
      } catch {
        if (tabRef.current === which) addToast('Failed to load invites', 'warning');
      } finally {
        if (tabRef.current === which) setInvitesLoading(false);
      }
    },
    [addToast],
  );

  useEffect(() => {
    if (instanceSettings) {
      setDraft({
        registrationOpen: instanceSettings.registrationOpen,
        federatedRegistrationOpen: instanceSettings.federatedRegistrationOpen,
      });
      setSaveError('');
    }
  }, [instanceSettings]);

  useEffect(() => {
    fetchInvites(tab);
  }, [tab, fetchInvites]);

  if (!draft) return <div className="text-sm text-txt-tertiary">Loading settings...</div>;

  const hasChanges = !!instanceSettings && (
    draft.registrationOpen !== instanceSettings.registrationOpen ||
    draft.federatedRegistrationOpen !== instanceSettings.federatedRegistrationOpen
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateInstanceSettings({
        registrationOpen: draft.registrationOpen,
        federatedRegistrationOpen: draft.federatedRegistrationOpen,
      });
      addToast('Registration settings saved', 'success', 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      setSaveError(message);
      addToast('Failed to update registration settings', 'warning');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) {
      setDraft({
        registrationOpen: instanceSettings.registrationOpen,
        federatedRegistrationOpen: instanceSettings.federatedRegistrationOpen,
      });
    }
    setSaveError('');
  };

  return (
    <>
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">Registration</h2>
      <div className="text-xs text-txt-tertiary">
        Control who can create accounts on this instance. Public registration covers local
        sign-ups; federated registration covers users from peered instances creating an account here.
      </div>

      {/* Public registration */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Public Registration</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-txt-primary">Allow new local accounts</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                Anyone can create a local account from the registration page. When off, only invite
                links can create new local accounts.
              </div>
            </div>
            <Toggle
              enabled={draft.registrationOpen}
              onChange={(v) => setDraft({ ...draft, registrationOpen: v })}
            />
          </label>
        </div>
      </div>

      {/* Federated registration */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Federated Registration</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <label className="flex items-center justify-between cursor-pointer gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium text-txt-primary">Allow new federated accounts</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                Users from other instances can create a federated account here via their Connections
                settings. Existing federated accounts can always log in regardless of this setting.
              </div>
            </div>
            <Toggle
              enabled={draft.federatedRegistrationOpen}
              onChange={(v) => setDraft({ ...draft, federatedRegistrationOpen: v })}
            />
          </label>
        </div>
      </div>

      {/* Invite Links */}
      <div className="border-t border-white/[0.06] pt-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider">Invite Links</div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-lg transition-colors"
          >
            + Create link
          </button>
        </div>

        <div className="flex gap-1 mb-3 p-1 bg-surface-input rounded-lg w-fit">
          {(['active', 'archived'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-sm rounded transition-colors ${
                tab === t
                  ? 'bg-accent-primary text-white'
                  : 'text-txt-tertiary hover:text-txt-primary'
              }`}
            >
              {t === 'active' ? 'Active' : 'Archived'}
            </button>
          ))}
        </div>

        {invitesLoading ? (
          <div className="text-sm text-txt-tertiary">Loading...</div>
        ) : invites.length === 0 ? (
          <div className="text-sm text-txt-tertiary">
            {tab === 'active' ? 'No active invite links.' : 'No archived invite links.'}
          </div>
        ) : (
          <div className="space-y-2">
            {invites.map((inv) => (
              <InviteRow key={inv.id} invite={inv} onMutate={() => fetchInvites(tab)} />
            ))}
          </div>
        )}
      </div>

      {/* Status messages */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {/* Save / Reset bar */}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>

    {showCreate && (
      <CreateInviteModal
        onClose={() => setShowCreate(false)}
        onCreated={() => fetchInvites('active')}
      />
    )}
    </>
  );
}
