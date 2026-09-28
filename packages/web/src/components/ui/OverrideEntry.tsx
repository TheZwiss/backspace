import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriStateToggle, type TriState } from './TriStateToggle';
import { PermissionBits } from '../../utils/permissions';
import { Tooltip } from './Tooltip';

const TRASH_ICON = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
const LOCK_ICON = 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z';

export type PermissionKey = keyof typeof PermissionBits;

export interface PermissionDef {
  key: PermissionKey;
  bit: bigint;
}

/**
 * The display name of every permission bit in the current language. One
 * place for the wording, so the role editor, the channel overrides and the
 * category overrides all call a permission the same thing.
 */
export function usePermissionNames(): Record<PermissionKey, string> {
  const { t } = useTranslation(['spaces']);
  return useMemo(() => ({
    ADMINISTRATOR: t('spaces:permissions.names.administrator'),
    VIEW_CHANNEL: t('spaces:permissions.names.viewChannel'),
    MANAGE_CHANNELS: t('spaces:permissions.names.manageChannels'),
    MANAGE_ROLES: t('spaces:permissions.names.manageRoles'),
    MANAGE_SPACE: t('spaces:permissions.names.manageSpace'),
    CREATE_INVITE: t('spaces:permissions.names.createInvite'),
    KICK_MEMBERS: t('spaces:permissions.names.kickMembers'),
    BAN_MEMBERS: t('spaces:permissions.names.banMembers'),
    SEND_MESSAGES: t('spaces:permissions.names.sendMessages'),
    MANAGE_MESSAGES: t('spaces:permissions.names.manageMessages'),
    ATTACH_FILES: t('spaces:permissions.names.attachFiles'),
    READ_MESSAGE_HISTORY: t('spaces:permissions.names.readMessageHistory'),
    ADD_REACTIONS: t('spaces:permissions.names.addReactions'),
    CONNECT: t('spaces:permissions.names.connect'),
    SPEAK: t('spaces:permissions.names.speak'),
    MUTE_MEMBERS: t('spaces:permissions.names.muteMembers'),
    DEAFEN_MEMBERS: t('spaces:permissions.names.deafenMembers'),
    MOVE_MEMBERS: t('spaces:permissions.names.moveMembers'),
    STREAM: t('spaces:permissions.names.stream'),
    DISCONNECT_MEMBERS: t('spaces:permissions.names.disconnectMembers'),
  }), [t]);
}

export function OverrideEntry({
  label,
  color,
  permDefs,
  allow,
  deny,
  onChange,
  onRemove,
  lockedBits = 0n,
  removeLocked = false,
}: {
  label: string;
  color?: string;
  permDefs: PermissionDef[];
  allow: bigint;
  deny: bigint;
  onChange: (allow: bigint, deny: bigint) => void;
  onRemove?: () => void;
  /** Bits the viewer may not switch (held-bits rule): their toggles show their state, locked. */
  lockedBits?: bigint;
  /** The saved override sets a bit the viewer does not hold, so they may not remove it. */
  removeLocked?: boolean;
}) {
  const { t } = useTranslation(['spaces']);
  const permissionNames = usePermissionNames();
  const [expanded, setExpanded] = useState(false);

  const getState = (bit: bigint): TriState => {
    if ((allow & bit) !== 0n) return 'allow';
    if ((deny & bit) !== 0n) return 'deny';
    return 'neutral';
  };

  const setState = (bit: bigint, state: TriState) => {
    if ((lockedBits & bit) !== 0n) return;
    let newAllow = allow & ~bit;
    let newDeny = deny & ~bit;
    if (state === 'allow') newAllow |= bit;
    if (state === 'deny') newDeny |= bit;
    onChange(newAllow, newDeny);
  };

  // Compact summary of non-neutral permissions
  const summary = permDefs.filter(p => getState(p.bit) !== 'neutral');
  const panelId = useId();
  const removable = !!onRemove;
  const hasLockedRow = permDefs.some((p) => (lockedBits & p.bit) !== 0n);

  return (
    <div className="rounded-lg bg-white/[0.02] overflow-hidden">
      {/* The expand toggle and the remove action are siblings: a button inside
          a button is invalid HTML and reads as one control. */}
      <div className="flex items-center hover:bg-interactive-hover transition-colors">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-1.5 py-2 text-left"
        >
          <span
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: color || '#b9bbbe' }}
          />
          <span className="text-sm font-medium text-txt-primary flex-1 truncate">{label}</span>
          {!expanded && summary.length > 0 && (
            <span className="text-[11px] text-txt-tertiary flex-shrink-0">
              {t('spaces:permissions.overrideCount', { count: summary.length })}
            </span>
          )}
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
            className={`text-txt-tertiary transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
          </svg>
        </button>
        {removable ? (
          <Tooltip content={t(removeLocked ? 'spaces:permissions.removeUnheldShort' : 'spaces:permissions.removeOverride')} position="top">
            <button
              type="button"
              onClick={removeLocked ? undefined : onRemove}
              disabled={removeLocked}
              aria-label={t('spaces:permissions.removeOverrideFor', { name: label })}
              className={`w-7 h-7 mr-1.5 flex items-center justify-center rounded text-txt-tertiary transition-colors ${
                removeLocked ? 'opacity-40 cursor-not-allowed' : 'hover:text-accent-rose hover:bg-accent-rose/10'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d={TRASH_ICON} />
              </svg>
            </button>
          </Tooltip>
        ) : (
          // Keeps every row's chevron in the same column as the removable rows.
          <span className="w-7 h-7 mr-1.5 flex-shrink-0" aria-hidden="true" />
        )}
      </div>
      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-label={label}
          className="px-3 pb-3 space-y-1.5 border-t border-white/[0.04] pt-2"
        >
          {hasLockedRow && (
            <div className="flex items-start gap-2 pb-1 text-[12px] leading-snug text-txt-tertiary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="flex-shrink-0 mt-[2px]">
                <path d={LOCK_ICON} />
              </svg>
              <span>{t('spaces:permissions.unheldLocked')}</span>
            </div>
          )}
          {permDefs.map((perm) => {
            const locked = (lockedBits & perm.bit) !== 0n;
            const name = permissionNames[perm.key];
            return (
              <div key={perm.key} className="flex items-center justify-between gap-3">
                <span className={`text-[13px] text-txt-secondary${locked ? ' opacity-60' : ''}`}>{name}</span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  {locked && (
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
                      className="text-txt-tertiary"
                      role="img"
                      aria-label={t('spaces:permissions.unheldPermission')}
                    >
                      <title>{t('spaces:permissions.unheldPermission')}</title>
                      <path d={LOCK_ICON} />
                    </svg>
                  )}
                  <TriStateToggle
                    value={getState(perm.bit)}
                    onChange={(v) => setState(perm.bit, v)}
                    disabled={locked}
                    label={name}
                  />
                </span>
              </div>
            );
          })}
          {removable && (
            <div className="flex items-center justify-between gap-3 pt-2.5 !mt-2.5 border-t border-white/[0.04]">
              <span className="text-[12px] leading-snug text-txt-tertiary">
                {t(removeLocked ? 'spaces:permissions.removeUnheld' : 'spaces:permissions.removeOverrideHint')}
              </span>
              <button
                type="button"
                onClick={removeLocked ? undefined : onRemove}
                disabled={removeLocked}
                className={`flex-shrink-0 px-2.5 py-1 rounded text-[12.5px] font-medium text-accent-rose transition-colors ${
                  removeLocked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent-rose/10'
                }`}
              >
                {t('spaces:permissions.removeOverride')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
