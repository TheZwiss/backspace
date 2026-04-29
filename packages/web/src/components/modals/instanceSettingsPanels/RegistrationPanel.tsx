import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InviteLinkSummary, InviteRedemption, InviteStatus } from '@backspace/shared';
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

function inviteStatusDotColor(status: InviteStatus): string {
  switch (status) {
    case 'active':    return 'bg-status-online';
    case 'expired':   return 'bg-accent-rose';
    case 'exhausted': return 'bg-accent-amber';
    case 'revoked':   return 'bg-txt-tertiary';
  }
}

function inviteStatusPillColor(status: InviteStatus): string {
  switch (status) {
    case 'expired':   return 'bg-accent-rose/15 text-accent-rose';
    case 'exhausted': return 'bg-accent-amber/15 text-accent-amber';
    case 'revoked':   return 'bg-white/5 text-txt-tertiary';
    case 'active':    return ''; // never rendered for active
  }
}

function inviteStatusLabel(status: InviteStatus): string {
  switch (status) {
    case 'active':    return 'Active';
    case 'expired':   return 'Expired';
    case 'exhausted': return 'Exhausted';
    case 'revoked':   return 'Revoked';
  }
}

// ---------------------------------------------------------------------------
// Sort / filter types
// ---------------------------------------------------------------------------

type ActiveSort = 'recent' | 'oldest' | 'name' | 'mostUsed' | 'expiringSoonest';
type ArchivedSort = 'recent' | 'oldest' | 'name';
type ArchivedStatus = 'expired' | 'exhausted' | 'revoked';

// ---------------------------------------------------------------------------
// Sort / filter pure functions
// Sort/filter applied client-side. At ~500+ invites in a single bucket,
// move to server-side: add `?sort=` and `?status=` params to /admin/invites,
// page through results. Today the test instances have <50 invites total.
// ---------------------------------------------------------------------------

function sortInvites(
  list: InviteLinkSummary[],
  sortKey: ActiveSort | ArchivedSort,
): InviteLinkSummary[] {
  const arr = [...list];
  switch (sortKey) {
    case 'recent':
      return arr.sort((a, b) => b.createdAt - a.createdAt);
    case 'oldest':
      return arr.sort((a, b) => a.createdAt - b.createdAt);
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name));
    case 'mostUsed':
      return arr.sort((a, b) => b.usedCount - a.usedCount);
    case 'expiringSoonest':
      return arr.sort((a, b) => {
        // null expiresAt (no expiration) sorts last
        if (a.expiresAt === null && b.expiresAt === null) return 0;
        if (a.expiresAt === null) return 1;
        if (b.expiresAt === null) return -1;
        return a.expiresAt - b.expiresAt;
      });
  }
}

function filterInvitesByStatus(
  list: InviteLinkSummary[],
  statuses: Set<ArchivedStatus>,
): InviteLinkSummary[] {
  // ArchivedStatus excludes 'active' by construction — this filter is only
  // applied on the archived tab where all invites have a non-active status.
  return list.filter((inv) => statuses.has(inv.status as ArchivedStatus));
}

// ---------------------------------------------------------------------------
// FilterDropdown
// ---------------------------------------------------------------------------

interface FilterDropdownProps {
  view: 'active' | 'archived';
  activeSort: ActiveSort;
  onActiveSortChange: (s: ActiveSort) => void;
  archivedSort: ArchivedSort;
  onArchivedSortChange: (s: ArchivedSort) => void;
  archivedStatusFilter: Set<ArchivedStatus>;
  onArchivedStatusToggle: (s: ArchivedStatus) => void;
}

function FilterDropdown({
  view,
  activeSort,
  onActiveSortChange,
  archivedSort,
  onArchivedSortChange,
  archivedStatusFilter,
  onArchivedStatusToggle,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);

  const activeSortOptions: Array<{ key: ActiveSort; label: string }> = [
    { key: 'recent', label: 'Most recent' },
    { key: 'oldest', label: 'Oldest' },
    { key: 'name', label: 'Name (A–Z)' },
    { key: 'mostUsed', label: 'Most used' },
    { key: 'expiringSoonest', label: 'Expiring soonest' },
  ];

  const archivedSortOptions: Array<{ key: ArchivedSort; label: string }> = [
    { key: 'recent', label: 'Most recent' },
    { key: 'oldest', label: 'Oldest' },
    { key: 'name', label: 'Name (A–Z)' },
  ];

  const archivedStatusOptions: ArchivedStatus[] = ['expired', 'exhausted', 'revoked'];

  const handleArchivedStatusToggle = (s: ArchivedStatus) => {
    // Prevent deselecting the last selected status — always keep at least one.
    if (archivedStatusFilter.has(s) && archivedStatusFilter.size === 1) return;
    onArchivedStatusToggle(s);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-txt-tertiary hover:text-txt-secondary bg-white/[0.04] hover:bg-white/[0.06] rounded transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="opacity-60">
          <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Filter
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 glass rounded-lg p-1.5 w-48">
            {view === 'archived' && (
              <>
                <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1">
                  Status
                </div>
                {archivedStatusOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleArchivedStatusToggle(s)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded ${
                      archivedStatusFilter.has(s)
                        ? 'text-txt-primary bg-white/[0.04]'
                        : 'text-txt-tertiary'
                    } hover:bg-white/[0.06] transition-colors`}
                  >
                    <div className={`w-2 h-2 rounded-full ${inviteStatusDotColor(s)}`} />
                    <span>{inviteStatusLabel(s)}</span>
                  </button>
                ))}
                <div className="h-px bg-white/[0.06] my-1" />
              </>
            )}
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1">
              Sort by
            </div>
            {view === 'active'
              ? activeSortOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => { onActiveSortChange(opt.key); setOpen(false); }}
                    className={`w-full text-left px-2 py-1.5 text-xs rounded ${
                      activeSort === opt.key
                        ? 'text-accent-lavender bg-accent-lavender/[0.08]'
                        : 'text-txt-primary'
                    } hover:bg-white/[0.06] transition-colors`}
                  >
                    {opt.label}
                  </button>
                ))
              : archivedSortOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => { onArchivedSortChange(opt.key); setOpen(false); }}
                    className={`w-full text-left px-2 py-1.5 text-xs rounded ${
                      archivedSort === opt.key
                        ? 'text-accent-lavender bg-accent-lavender/[0.08]'
                        : 'text-txt-primary'
                    } hover:bg-white/[0.06] transition-colors`}
                  >
                    {opt.label}
                  </button>
                ))}
          </div>
        </>
      )}
    </div>
  );
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
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-white/[0.06] flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-lavender/15 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-lavender">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-[16px] font-bold text-txt-primary">Create invite link</h3>
            <p className="text-[13px] text-txt-secondary leading-snug mt-0.5">
              Generate a shareable link that lets people register on this instance. You'll set how many times it can be used and when it expires.
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
          className="px-5 pt-4 pb-5 space-y-5"
        >
          {/* Name */}
          <div>
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Name</div>
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
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Max uses</div>
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
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Expires</div>
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
          </div>

          {/* Actions */}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="py-2.5 px-4 rounded-lg text-[13px] font-medium text-txt-tertiary border border-white/[0.06] hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors disabled:opacity-50"
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
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-white/[0.06] flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-lavender/15 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-lavender">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-[16px] font-bold text-txt-primary">Edit "{invite.name}"</h3>
            <p className="text-[13px] text-txt-secondary leading-snug mt-0.5">
              Adjust the limits on this invite link. The URL stays the same — anyone who already has it can still redeem under the new constraints.
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="px-5 pt-4 pb-5 space-y-5"
        >
          {/* Name */}
          <div>
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Name</div>
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
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
              Max uses <span className="normal-case font-normal text-txt-tertiary">({invite.usedCount} used)</span>
            </div>
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
          <div>
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Expires</div>
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
          </div>

          {/* Actions */}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="py-2.5 px-4 rounded-lg text-[13px] font-medium text-txt-tertiary border border-white/[0.06] hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors disabled:opacity-50"
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

  const subtitle = isRevoked
    ? 'This invite was revoked. Reinstating generates a new link with a different URL — the old URL stays inactive.'
    : 'This invite has lapsed. Reinstating reactivates the same URL — anyone who saved it will be able to use it again.';

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
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-white/[0.06] flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-lavender/15 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-lavender">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-[16px] font-bold text-txt-primary">Reinstate "{invite.name}"</h3>
            <p className="text-[13px] text-txt-secondary leading-snug mt-0.5">{subtitle}</p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleReinstate();
          }}
          className="px-5 pt-4 pb-5 space-y-5"
        >
          {/* Amber callout — only for revoked variant to reinforce the "new URL" consequence */}
          {isRevoked && (
            <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20 text-[13px] text-accent-amber">
              A new link will be generated. Anyone who had the old URL will not be able to use it.
            </div>
          )}

          {/* Max uses */}
          <div>
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
              Max uses <span className="normal-case font-normal text-txt-tertiary">(current: {invite.maxUses ?? '∞'}, used: {invite.usedCount})</span>
            </div>
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
          <div>
            <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Expires</div>
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
          </div>

          {/* Actions */}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="py-2.5 px-4 rounded-lg text-[13px] font-medium text-txt-tertiary border border-white/[0.06] hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors disabled:opacity-50"
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
        {/* Header */}
        <div className="px-5 pt-5 pb-4 border-b border-white/[0.06] flex items-start gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-lg bg-accent-sky/15 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-accent-sky">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[16px] font-bold text-txt-primary">Redemptions for "{invite.name}"</h3>
            <p className="text-[13px] text-txt-secondary leading-snug mt-0.5">
              Users who registered using this invite link, in the order they signed up.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-md text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] flex items-center justify-center flex-shrink-0 transition-colors"
          >
            ×
          </button>
        </div>

        <div className="px-5 pt-4 pb-3 space-y-3">
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
  expanded: boolean;
  onToggleExpand: () => void;
  onMutate: () => void;
}

/**
 * One row in the invite list. Renders as a clickable collapsed header that, when
 * expanded, reveals a meta grid + status-specific action row. Owns its own modal
 * and confirm-dialog state so the parent panel only manages list-level fetch +
 * single-row expansion state (`expandedInviteId`).
 *
 * Action surface depends on `invite.status`:
 *   - active     → Copy link · Edit · Revoke · View redemptions
 *   - non-active → Reinstate · Delete permanently · View redemptions
 */
function InviteRow({ invite, expanded, onToggleExpand, onMutate }: InviteRowProps) {
  const addToast = useUIStore((s) => s.addToast);
  const [showEdit, setShowEdit] = useState(false);
  const [showReinstate, setShowReinstate] = useState(false);
  const [showRedemptions, setShowRedemptions] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const usageLabel =
    invite.maxUses === null
      ? `${invite.usedCount} / ∞`
      : `${invite.usedCount} / ${invite.maxUses}`;

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

  const isActive = invite.status === 'active';
  const createdByLabel = invite.createdByUsername ?? 'Unknown';

  // Subtitle (collapsed view)
  //   active   → "X / Y uses · Expires in 3 days · Created by alice"
  //   archived → "X / Y uses · Revoked 4/12/2026 · 2d ago"
  const subtitle = isActive
    ? `${usageLabel} uses · ${formatExpiry(invite)} · Created by ${createdByLabel}`
    : `${usageLabel} uses · ${formatExpiry(invite)} · ${formatRelative(invite.createdAt)}`;

  // Archived row 1 second-cell label + value. EXHAUSTED has no dedicated terminal
  // timestamp on the invite, so we surface lastRedeemedAt (the moment that drove
  // it to exhausted) when known, falling back to em-dash if absent.
  let archivedTerminalLabel: string;
  let archivedTerminalValue: string;
  if (invite.status === 'expired') {
    archivedTerminalLabel = 'EXPIRED AT';
    archivedTerminalValue = invite.expiresAt !== null ? formatRelative(invite.expiresAt) : '—';
  } else if (invite.status === 'revoked') {
    archivedTerminalLabel = 'REVOKED AT';
    archivedTerminalValue = invite.revokedAt !== null ? formatRelative(invite.revokedAt) : '—';
  } else {
    // exhausted
    archivedTerminalLabel = 'EXHAUSTED';
    archivedTerminalValue =
      invite.lastRedeemedAt !== null ? formatRelative(invite.lastRedeemedAt) : '—';
  }

  const tokenDisplay = `…${invite.token.slice(-6)}`;
  const lastRedeemedDisplay =
    invite.lastRedeemedAt !== null ? formatRelative(invite.lastRedeemedAt) : '—';

  return (
    <>
      <div
        className={`bg-white/[0.02] rounded-md transition-colors ${
          expanded ? 'border border-white/[0.06]' : ''
        }`}
      >
        {/* Collapsed clickable header */}
        <div
          className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-white/[0.02] rounded-md"
          onClick={onToggleExpand}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${inviteStatusDotColor(invite.status)}`} />
            <div className="min-w-0">
              <div
                className="text-sm font-medium truncate text-txt-primary"
                title={invite.name}
              >
                {invite.name}
              </div>
              <div className="text-[11px] text-txt-tertiary truncate">{subtitle}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            {!isActive && (
              <span
                className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${inviteStatusPillColor(invite.status)}`}
              >
                {inviteStatusLabel(invite.status)}
              </span>
            )}
            <span className="text-txt-tertiary text-xs">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>

        {/* Expanded body */}
        {expanded && (
          <div className="px-3 pb-3">
            <div className="border-t border-white/[0.05] pt-3">
              {/* Row 1: USED · (EXPIRES | terminal-status AT) · CREATED */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div>
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Used</div>
                  <div
                    className={`text-xs ${
                      usageNearLimit ? 'text-accent-amber font-medium' : 'text-txt-secondary'
                    }`}
                  >
                    {usageLabel}
                  </div>
                </div>
                {isActive ? (
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Expires</div>
                    <div className="text-xs text-txt-secondary">{formatExpiry(invite)}</div>
                  </div>
                ) : (
                  <div>
                    <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">
                      {archivedTerminalLabel}
                    </div>
                    <div className="text-xs text-txt-secondary">{archivedTerminalValue}</div>
                  </div>
                )}
                <div>
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Created</div>
                  <div className="text-xs text-txt-secondary">{formatRelative(invite.createdAt)}</div>
                </div>
              </div>

              {/* Row 2: CREATED BY · TOKEN · LAST REDEEMED */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div>
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Created by</div>
                  <div className="text-xs text-txt-secondary truncate" title={createdByLabel}>
                    {createdByLabel}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Token</div>
                  <div className="text-xs font-mono text-txt-secondary" title={invite.token}>
                    {tokenDisplay}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-txt-tertiary uppercase tracking-wider mb-0.5">Last redeemed</div>
                  <div className="text-xs text-txt-secondary">{lastRedeemedDisplay}</div>
                </div>
              </div>

              {/* Action row */}
              <div className="flex items-center gap-2 flex-wrap">
                {isActive ? (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-lavender/10 text-accent-lavender hover:bg-accent-lavender/20 rounded transition-colors"
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowEdit(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-lavender/10 text-accent-lavender hover:bg-accent-lavender/20 rounded transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setConfirmRevoke(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                    >
                      Revoke
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowRedemptions(true); }}
                      className="text-[11px] text-txt-tertiary hover:text-txt-secondary underline decoration-dotted transition-colors ml-1"
                    >
                      View redemptions
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowReinstate(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-status-online/10 text-status-online hover:bg-status-online/20 rounded transition-colors"
                    >
                      Reinstate
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                    >
                      Delete permanently
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowRedemptions(true); }}
                      className="text-[11px] text-txt-tertiary hover:text-txt-secondary underline decoration-dotted transition-colors ml-1"
                    >
                      View redemptions
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
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
  const [activeCount, setActiveCount] = useState<number>(0);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  // Single-row expansion state — only one InviteRow at a time may be expanded.
  // Lifted to the panel so switching tabs can reset it; otherwise an expanded row
  // that scrolls out of the visible list keeps stale state.
  const [expandedInviteId, setExpandedInviteId] = useState<string | null>(null);

  // Sort / filter state — independent per tab so switching tabs preserves each
  // tab's last selection.
  const [activeSort, setActiveSort] = useState<ActiveSort>('recent');
  const [archivedSort, setArchivedSort] = useState<ArchivedSort>('recent');
  const [archivedStatusFilter, setArchivedStatusFilter] = useState<Set<ArchivedStatus>>(
    () => new Set<ArchivedStatus>(['expired', 'exhausted', 'revoked']),
  );

  const toggleArchivedStatus = (s: ArchivedStatus) => {
    setArchivedStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const handleTabSwitch = (next: 'active' | 'archived') => {
    setTab(next);
    setExpandedInviteId(null);
  };

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

  const refreshCounts = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([
        api.invites.list('active'),
        api.invites.list('archived'),
      ]);
      setActiveCount(a.invites.length);
      setArchivedCount(r.invites.length);
    } catch {
      // Leave previous counts on transient failure
    }
  }, []);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

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

  // Derived sorted + filtered list. Tab badge counts (`activeCount`/`archivedCount`)
  // are NOT derived from this — they reflect the full unfiltered bucket size.
  // Must be declared before any conditional early-return to satisfy rules-of-hooks.
  const displayInvites = useMemo(() => {
    let list = invites;
    if (tab === 'archived') {
      list = filterInvitesByStatus(list, archivedStatusFilter);
    }
    list = sortInvites(list, tab === 'active' ? activeSort : archivedSort);
    return list;
  }, [invites, tab, activeSort, archivedSort, archivedStatusFilter]);

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
        {/* Row 1: heading + create button */}
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

        {/* Row 2: tab strip (left) + FilterDropdown (right) */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex bg-white/[0.04] rounded-md p-0.5">
            <button
              type="button"
              onClick={() => handleTabSwitch('active')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                tab === 'active' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              Active <span className="text-[10px] text-txt-tertiary ml-0.5">{activeCount}</span>
            </button>
            <button
              type="button"
              onClick={() => handleTabSwitch('archived')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                tab === 'archived' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
            >
              Archived <span className="text-[10px] text-txt-tertiary ml-0.5">{archivedCount}</span>
            </button>
          </div>
          <FilterDropdown
            view={tab}
            activeSort={activeSort}
            onActiveSortChange={setActiveSort}
            archivedSort={archivedSort}
            onArchivedSortChange={setArchivedSort}
            archivedStatusFilter={archivedStatusFilter}
            onArchivedStatusToggle={toggleArchivedStatus}
          />
        </div>

        {invitesLoading ? (
          <div className="text-sm text-txt-tertiary">Loading...</div>
        ) : invites.length === 0 ? (
          <div className="text-sm text-txt-tertiary">
            {tab === 'active' ? 'No active invite links.' : 'No archived invite links.'}
          </div>
        ) : displayInvites.length === 0 ? (
          <div className="text-[11px] text-txt-tertiary py-3 text-center">
            No invites match the current filter.
          </div>
        ) : (
          <div className="space-y-2">
            {displayInvites.map((inv) => (
              <InviteRow
                key={inv.id}
                invite={inv}
                expanded={expandedInviteId === inv.id}
                onToggleExpand={() =>
                  setExpandedInviteId(expandedInviteId === inv.id ? null : inv.id)
                }
                onMutate={() => { fetchInvites(tab); refreshCounts(); }}
              />
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
        onCreated={() => { fetchInvites('active'); refreshCounts(); }}
      />
    )}
    </>
  );
}
