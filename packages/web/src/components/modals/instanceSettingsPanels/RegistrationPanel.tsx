import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InviteLinkSummary, InviteRedemption } from '@backspace/shared';
import { api } from '../../../api/client';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { ConfirmDialog } from '../../ui/ConfirmDialog';

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

type ExpiryPresetId = '1h' | '24h' | '7d' | '30d' | 'never' | 'custom';

/** Edit modal additionally supports a 'keep' option (don't change expiry on PATCH). */
type EditExpiryId = 'keep' | ExpiryPresetId;

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

interface ExpirySelectorProps {
  value: EditExpiryId;
  customDateTime: string;
  onChange: (value: EditExpiryId, customDateTime: string) => void;
  /** When true, prepends a "Keep current" pill (used by Edit). Create/Reinstate omit it. */
  showKeep: boolean;
  disabled?: boolean;
}

/**
 * Shared expiry preset row + custom datetime input. Used by Create, Edit, and Reinstate
 * modals so the picker UX stays consistent across all three flows.
 *
 * Resolution rules (applied by callers via `resolveExpiryFromSelector` below):
 *   'keep'   → omit `expiresAt` from request body (Edit only)
 *   'never'  → expiresAt: null
 *   'custom' → expiresAt: new Date(customDateTime).getTime() (validated by caller)
 *   preset   → expiresAt: Date.now() + preset.ms
 */
function ExpirySelector({ value, customDateTime, onChange, showKeep, disabled }: ExpirySelectorProps) {
  return (
    <div>
      <label className="block text-sm text-txt-secondary mb-1.5">Expires</label>
      <div className="flex items-center gap-2 flex-wrap">
        {showKeep && (
          <button
            type="button"
            onClick={() => onChange('keep', customDateTime)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
              value === 'keep'
                ? 'bg-accent-primary text-white'
                : 'bg-surface-input text-txt-tertiary hover:text-txt-secondary'
            }`}
          >
            Keep current
          </button>
        )}
        {EXPIRY_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id, customDateTime)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
              value === p.id
                ? 'bg-accent-primary text-white'
                : 'bg-surface-input text-txt-tertiary hover:text-txt-secondary'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value === 'custom' && (
        <input
          type="datetime-local"
          value={customDateTime}
          onChange={(e) => onChange('custom', e.target.value)}
          min={toDatetimeLocalValue(Date.now() + 60_000)}
          disabled={disabled}
          className="input-standard w-full px-3 py-2 text-sm mt-2"
        />
      )}
    </div>
  );
}

/**
 * Resolve an `ExpirySelector` selection into a `expiresAt` timestamp for API bodies.
 *
 * Returns one of:
 *   - `{ kind: 'omit' }`        — caller should NOT include `expiresAt` in the body (Edit "Keep current")
 *   - `{ kind: 'value', expiresAt: number | null }` — caller sets `body.expiresAt = expiresAt`
 *   - `{ kind: 'invalid', message: string }` — caller should toast the message and abort
 */
function resolveExpiryFromSelector(
  value: EditExpiryId,
  customDateTime: string,
):
  | { kind: 'omit' }
  | { kind: 'value'; expiresAt: number | null }
  | { kind: 'invalid'; message: string } {
  if (value === 'keep') return { kind: 'omit' };
  if (value === 'never') return { kind: 'value', expiresAt: null };
  if (value === 'custom') {
    if (customDateTime === '') {
      return { kind: 'invalid', message: 'Pick a future date & time' };
    }
    const ts = new Date(customDateTime).getTime();
    if (!Number.isFinite(ts) || ts <= Date.now()) {
      return { kind: 'invalid', message: 'Pick a future date & time' };
    }
    return { kind: 'value', expiresAt: ts };
  }
  const preset = EXPIRY_PRESETS.find((p) => p.id === value);
  if (!preset || preset.ms === null) {
    // Unreachable: 'never' and 'custom' are handled above; remaining ids all carry an ms.
    return { kind: 'invalid', message: 'Invalid expiry selection' };
  }
  return { kind: 'value', expiresAt: Date.now() + preset.ms };
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

    // Create never uses the 'keep' option — it always sets a concrete expiry.
    const resolved = resolveExpiryFromSelector(expiryId, customDateTime);
    if (resolved.kind === 'invalid') {
      addToast(resolved.message, 'warning');
      return;
    }
    if (resolved.kind === 'omit') {
      // Unreachable: ExpirySelector for Create is rendered with showKeep={false}, so
      // 'keep' cannot be selected. Defensive guard so future refactors fail loudly.
      addToast('Invalid expiry selection', 'warning');
      return;
    }
    const expiresAt = resolved.expiresAt;

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
          <ExpirySelector
            value={expiryId}
            customDateTime={customDateTime}
            onChange={(v, dt) => {
              // Create's expiryId state is the narrower ExpiryPresetId; 'keep' cannot
              // be returned because <ExpirySelector showKeep={false}> never renders it.
              if (v === 'keep') return;
              setExpiryId(v);
              setCustomDateTime(dt);
            }}
            showKeep={false}
            disabled={submitting}
          />

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

interface EditInviteModalProps {
  invite: InviteLinkSummary;
  onClose: () => void;
  onUpdated: () => void;
}

/**
 * Edit modal — same shape as Create, pre-filled. Only sends fields the user actually changed
 * (no-op churn avoidance). Disallowed for revoked rows (the row hides the Edit button entirely
 * — Reinstate is the only path back from revoked).
 */
function EditInviteModal({ invite, onClose, onUpdated }: EditInviteModalProps) {
  const addToast = useUIStore((s) => s.addToast);
  const [name, setName] = useState(invite.name);
  const [unlimited, setUnlimited] = useState(invite.maxUses === null);
  const [maxUses, setMaxUses] = useState(invite.maxUses?.toString() ?? '1');
  const [expiryId, setExpiryId] = useState<EditExpiryId>('keep');
  const [customDateTime, setCustomDateTime] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus name input on mount
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Escape closes the modal (capture phase so it fires before the parent settings modal handler)
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

  const handleSave = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      addToast('Name must be 1–64 characters', 'warning');
      return;
    }

    // Validate maxUses input only when the user has selected limited mode.
    // Server requires `maxUses >= usedCount` (a server-side floor of 1 still applies).
    let newMax: number | null = null;
    if (!unlimited) {
      const parsed = Number(maxUses);
      if (!Number.isInteger(parsed) || parsed < 1) {
        addToast('Max uses must be a positive integer', 'warning');
        return;
      }
      if (parsed < invite.usedCount) {
        addToast(
          `Max uses cannot be less than current uses (${invite.usedCount})`,
          'warning',
        );
        return;
      }
      newMax = parsed;
    }

    // Build a partial body — only include fields the user actually changed.
    const body: { name?: string; maxUses?: number | null; expiresAt?: number | null } = {};
    if (trimmed !== invite.name) body.name = trimmed;
    if (newMax !== invite.maxUses) body.maxUses = newMax;

    const resolved = resolveExpiryFromSelector(expiryId, customDateTime);
    if (resolved.kind === 'invalid') {
      addToast(resolved.message, 'warning');
      return;
    }
    if (resolved.kind === 'value') {
      body.expiresAt = resolved.expiresAt;
    }
    // 'omit' (Keep current) → leave expiresAt off the body entirely.

    if (Object.keys(body).length === 0) {
      addToast('No changes to save', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      await api.invites.update(invite.id, body);
      addToast('Invite updated', 'success', 2000);
      onUpdated();
      onClose();
    } catch (err) {
      addToast(`Failed to update invite: ${(err as Error).message}`, 'warning');
    } finally {
      setSubmitting(false);
    }
  };

  // Floor for the maxUses input — at least 1, but also at least usedCount so the
  // browser native validation matches the server's constraint.
  const maxUsesMin = Math.max(1, invite.usedCount);

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in"
      onClick={!submitting ? onClose : undefined}
    >
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-full max-w-md mx-4 glass-modal rounded-lg animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="p-6 space-y-5"
        >
          <h3 className="text-lg font-semibold text-txt-primary">Edit "{invite.name}"</h3>

          {/* Name */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              className="input-standard w-full"
              disabled={submitting}
            />
          </div>

          {/* Max uses */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">
              Max uses{' '}
              <span className="text-txt-tertiary">({invite.usedCount} used)</span>
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="editMaxUsesMode"
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
                  name="editMaxUsesMode"
                  checked={!unlimited}
                  onChange={() => setUnlimited(false)}
                  disabled={submitting}
                  className="accent-accent-primary"
                />
                <input
                  type="number"
                  min={maxUsesMin}
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
          <ExpirySelector
            value={expiryId}
            customDateTime={customDateTime}
            onChange={(v, dt) => {
              setExpiryId(v);
              setCustomDateTime(dt);
            }}
            showKeep={true}
            disabled={submitting}
          />

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
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

interface ReinstateInviteModalProps {
  invite: InviteLinkSummary;
  onClose: () => void;
  onReinstated: () => void;
}

/**
 * Reinstate modal. Two visual variants share one component:
 *   - Variant A (revoked):  warns that a NEW link will be generated; old URL stays dead.
 *   - Variant B (expired/exhausted): same URL becomes active again.
 *
 * Both variants always set a fresh expiry (the user is reactivating something whose
 * expiry has, by definition, lapsed or is being re-set). Server's reinstate handler
 * requires `maxUses > usedCount` for exhausted invites, hence the input min of usedCount+1.
 *
 * Toast and submit-label copy are derived from the response's `tokenRotated` flag and
 * the invite's pre-action status, respectively, per spec §4.2.
 */
function ReinstateInviteModal({ invite, onClose, onReinstated }: ReinstateInviteModalProps) {
  const addToast = useUIStore((s) => s.addToast);
  const isRevoked = invite.status === 'revoked';

  const [unlimited, setUnlimited] = useState(invite.maxUses === null);
  // Default to a value strictly greater than usedCount — for exhausted invites, that's
  // the minimum the server will accept; for others, it's a sensible bump.
  const [maxUses, setMaxUses] = useState(() => {
    const baseline = invite.maxUses ?? invite.usedCount + 1;
    return Math.max(baseline, invite.usedCount + 1).toString();
  });
  const [expiryId, setExpiryId] = useState<ExpiryPresetId>('7d');
  const [customDateTime, setCustomDateTime] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  // Escape closes (capture phase to avoid bubbling into parent settings modal)
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

  const maxUsesMin = invite.usedCount + 1;

  const handleReinstate = async () => {
    // Validate maxUses when limited.
    let newMax: number | null = null;
    if (!unlimited) {
      const parsed = Number(maxUses);
      if (!Number.isInteger(parsed) || parsed < maxUsesMin) {
        addToast(
          `Max uses must be at least ${maxUsesMin} (current uses: ${invite.usedCount})`,
          'warning',
        );
        return;
      }
      newMax = parsed;
    }

    // Reinstate always sets a new expiry — no 'keep' option in this flow.
    const resolved = resolveExpiryFromSelector(expiryId, customDateTime);
    if (resolved.kind === 'invalid') {
      addToast(resolved.message, 'warning');
      return;
    }
    if (resolved.kind === 'omit') {
      // Unreachable: ExpirySelector for Reinstate is rendered with showKeep={false}.
      addToast('Invalid expiry selection', 'warning');
      return;
    }

    const body: { maxUses?: number | null; expiresAt?: number | null } = {
      maxUses: newMax,
      expiresAt: resolved.expiresAt,
    };

    setSubmitting(true);
    try {
      const result = await api.invites.reinstate(invite.id, body);
      if (result.tokenRotated) {
        try {
          await navigator.clipboard.writeText(result.invite.url);
          addToast('Reinstated with new link. Copied to clipboard.', 'success', 2500);
        } catch {
          addToast('Reinstated with new link. Copy manually from the row.', 'success', 2500);
        }
      } else {
        addToast('Reinstated. The same link is active again.', 'success', 2500);
      }
      onReinstated();
      onClose();
    } catch (err) {
      addToast(`Failed to reinstate: ${(err as Error).message}`, 'warning');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in"
      onClick={!submitting ? onClose : undefined}
    >
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-full max-w-md mx-4 glass-modal rounded-lg animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleReinstate();
          }}
          className="p-6 space-y-5"
        >
          <h3 className="text-lg font-semibold text-txt-primary">Reinstate "{invite.name}"</h3>

          {isRevoked ? (
            <p className="text-sm text-txt-secondary leading-relaxed">
              <strong className="text-txt-primary">This will generate a new link.</strong>{' '}
              The previously revoked URL stays inactive — anyone who had the old link will
              not be able to use it.
            </p>
          ) : (
            <p className="text-sm text-txt-secondary leading-relaxed">
              <strong className="text-txt-primary">The same link will start working again.</strong>{' '}
              Anyone who saved the URL will be able to use it.
            </p>
          )}

          {/* Max uses */}
          <div>
            <label className="block text-sm text-txt-secondary mb-1.5">
              Max uses{' '}
              <span className="text-txt-tertiary">
                (current: {invite.maxUses ?? '∞'}, used: {invite.usedCount})
              </span>
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="reinstateMaxUsesMode"
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
                  name="reinstateMaxUsesMode"
                  checked={!unlimited}
                  onChange={() => setUnlimited(false)}
                  disabled={submitting}
                  className="accent-accent-primary"
                />
                <input
                  type="number"
                  min={maxUsesMin}
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
          <ExpirySelector
            value={expiryId}
            customDateTime={customDateTime}
            onChange={(v, dt) => {
              if (v === 'keep') return; // unreachable: showKeep={false}
              setExpiryId(v);
              setCustomDateTime(dt);
            }}
            showKeep={false}
            disabled={submitting}
          />

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
              {submitting
                ? 'Reinstating…'
                : isRevoked
                  ? 'Reinstate with new link'
                  : 'Reinstate'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

interface RedemptionsModalProps {
  invite: InviteLinkSummary;
  onClose: () => void;
}

/**
 * Read-only redemption viewer. Each row shows the registrant's username at sign-up
 * time. When the live state has diverged (rename or account deletion), the row shows
 * the original name with the live state in parens — `alice (now Anastasia)` or
 * `bob (now Deleted User)` per spec §4.3.
 *
 * Note: the spec mentions opening the user's profile (UserPopover pattern) on row
 * click. That popover is not currently wired into a generic trigger callable from
 * outside its existing call sites, so this modal renders rows as non-interactive.
 * Adding click-through is a later polish pass — see Task 19 report.
 */
function RedemptionsModal({ invite, onClose }: RedemptionsModalProps) {
  const addToast = useUIStore((s) => s.addToast);
  const [redemptions, setRedemptions] = useState<InviteRedemption[] | null>(null);
  const [error, setError] = useState(false);

  // Escape closes (capture phase to avoid bubbling into parent settings modal)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api.invites
      .redemptions(invite.id)
      .then((r) => {
        if (!cancelled) setRedemptions(r.redemptions);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setRedemptions([]);
        addToast('Failed to load redemptions', 'warning');
      });
    return () => {
      cancelled = true;
    };
  }, [invite.id, addToast]);

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-full max-w-lg mx-4 glass-modal rounded-lg animate-slide-up overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-3 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-txt-primary truncate">
            Redemptions for "{invite.name}"
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-txt-tertiary hover:text-txt-primary text-xl leading-none px-1 -mt-1"
          >
            ×
          </button>
        </div>

        <div className="px-6 pb-3 space-y-3">
          {invite.status === 'revoked' && (
            <div className="bg-accent-rose/10 border border-accent-rose/30 rounded p-2.5 text-xs text-accent-rose leading-relaxed">
              This invite was revoked
              {invite.revokedAt
                ? ` ${new Date(invite.revokedAt).toLocaleDateString()}`
                : ''}
              . The redemptions below represent users who registered before revocation.
            </div>
          )}

          <div className="text-sm text-txt-tertiary">
            {invite.usedCount}
            {invite.maxUses !== null ? ` of ${invite.maxUses}` : ''} use
            {invite.usedCount === 1 ? '' : 's'}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {redemptions === null ? (
            <div className="text-sm text-txt-tertiary px-3 py-2">Loading…</div>
          ) : redemptions.length === 0 ? (
            <div className="text-sm text-txt-tertiary px-3 py-2">
              {error ? 'Could not load redemptions.' : 'No redemptions yet.'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {redemptions.map((r) => {
                const showCurrent =
                  !r.isDeleted &&
                  r.currentUsername !== null &&
                  r.currentUsername !== r.registrantUsername;
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-3 rounded hover:bg-surface-input cursor-default"
                  >
                    <span className="text-sm text-txt-primary truncate">
                      {r.registrantUsername}
                      {(r.isDeleted || showCurrent) && (
                        <span className="text-txt-tertiary">
                          {' '}
                          (now {r.isDeleted ? 'Deleted User' : r.currentUsername})
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-txt-tertiary shrink-0">
                      {new Date(r.redeemedAt).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface InviteRowProps {
  invite: InviteLinkSummary;
  onMutate: () => void;
}

/**
 * One row in the invite list. Owns its own modal/popover/confirm-dialog state so the
 * parent panel only deals with the list-level fetch + tab state.
 *
 * Action surface depends on `invite.status`:
 *   - active     → Copy link · Edit · Revoke  · ⋯ (View redemptions, Delete)
 *   - non-active → Reinstate                  · ⋯ (View redemptions, Delete)
 *
 * The kebab popover dismisses on outside click and Escape; clicks inside its items
 * already call `setShowKebab(false)` before triggering the action.
 */
function InviteRow({ invite, onMutate }: InviteRowProps) {
  const addToast = useUIStore((s) => s.addToast);
  const [showEdit, setShowEdit] = useState(false);
  const [showReinstate, setShowReinstate] = useState(false);
  const [showRedemptions, setShowRedemptions] = useState(false);
  const [showKebab, setShowKebab] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const kebabContainerRef = useRef<HTMLDivElement>(null);

  // Dismiss kebab popover on outside click + Escape. Mirrors the pattern used in
  // TransferOwnershipModal — listen on document, check containment via ref.
  useEffect(() => {
    if (!showKebab) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (
        kebabContainerRef.current &&
        !kebabContainerRef.current.contains(e.target as Node)
      ) {
        setShowKebab(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop propagation so the parent settings modal doesn't ALSO close.
        e.stopPropagation();
        setShowKebab(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showKebab]);

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

  const performRevoke = async () => {
    setActionLoading(true);
    try {
      await api.invites.revoke(invite.id);
      addToast('Invite revoked', 'success', 2000);
      setConfirmRevoke(false);
      onMutate();
    } catch (err) {
      addToast(`Failed to revoke: ${(err as Error).message}`, 'warning');
    } finally {
      setActionLoading(false);
    }
  };

  const performDelete = async () => {
    setActionLoading(true);
    try {
      await api.invites.delete(invite.id);
      addToast('Invite deleted', 'success', 2000);
      setConfirmDelete(false);
      onMutate();
    } catch (err) {
      addToast(`Failed to delete: ${(err as Error).message}`, 'warning');
    } finally {
      setActionLoading(false);
    }
  };

  const statusPillClass =
    invite.status === 'expired'
      ? 'bg-rose-500/20 text-rose-400'
      : invite.status === 'exhausted'
        ? 'bg-amber-500/20 text-amber-400'
        : 'bg-white/10 text-txt-tertiary';

  return (
    <>
      <div className="bg-white/[0.02] rounded-lg p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-sm font-medium text-txt-primary truncate"
              title={invite.name}
            >
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

        <div className="flex items-center gap-1 shrink-0 relative" ref={kebabContainerRef}>
          {invite.status === 'active' ? (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
              >
                Copy link
              </button>
              <button
                type="button"
                onClick={() => setShowEdit(true)}
                className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevoke(true)}
                className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
              >
                Revoke
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowReinstate(true)}
              className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
            >
              Reinstate
            </button>
          )}
          <button
            type="button"
            aria-label="More actions"
            onClick={() => setShowKebab((v) => !v)}
            className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors"
          >
            ⋯
          </button>
          {showKebab && (
            <div className="glass absolute right-0 top-full mt-1 py-1 w-44 z-10 rounded-md">
              <button
                type="button"
                onClick={() => {
                  setShowKebab(false);
                  setShowRedemptions(true);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-txt-secondary hover:text-txt-primary hover:bg-white/[0.04] transition-colors"
              >
                View redemptions
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowKebab(false);
                  setConfirmDelete(true);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-accent-rose hover:bg-accent-rose/10 transition-colors"
              >
                Delete permanently
              </button>
            </div>
          )}
        </div>
      </div>

      {showEdit && (
        <EditInviteModal
          invite={invite}
          onClose={() => setShowEdit(false)}
          onUpdated={onMutate}
        />
      )}
      {showReinstate && (
        <ReinstateInviteModal
          invite={invite}
          onClose={() => setShowReinstate(false)}
          onReinstated={onMutate}
        />
      )}
      {showRedemptions && (
        <RedemptionsModal invite={invite} onClose={() => setShowRedemptions(false)} />
      )}

      <ConfirmDialog
        isOpen={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={performRevoke}
        title={`Revoke "${invite.name}"?`}
        description={
          <>
            The link will stop working immediately. Anyone who has the URL will not be able
            to use it. You can reinstate the invite later — that will generate a new link
            with a different URL.
          </>
        }
        confirmLabel="Revoke link"
        variant="danger"
        loading={actionLoading}
      />

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={performDelete}
        title={`Delete "${invite.name}" permanently?`}
        description={
          <>
            This cannot be undone. Redemption history for this link will also be removed.
            If you only want to stop the link from working, use <strong>Revoke</strong>{' '}
            instead — that preserves the redemption record.
          </>
        }
        confirmLabel="Delete permanently"
        variant="danger"
        loading={actionLoading}
      />
    </>
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
