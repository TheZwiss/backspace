import { useCallback, useEffect, useState } from 'react';
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

export function RegistrationPanel() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<RegistrationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [invites, setInvites] = useState<InviteLinkSummary[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);

  const fetchInvites = useCallback(
    async (which: 'active' | 'archived') => {
      setInvitesLoading(true);
      try {
        const res = await api.invites.list(which);
        setInvites(res.invites);
      } catch {
        addToast('Failed to load invites', 'warning');
      } finally {
        setInvitesLoading(false);
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
  );
}
