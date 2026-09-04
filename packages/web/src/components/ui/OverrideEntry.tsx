import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriStateToggle, type TriState } from './TriStateToggle';
import { PermissionBits } from '../../utils/permissions';

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
  isEveryone,
}: {
  label: string;
  color?: string;
  permDefs: PermissionDef[];
  allow: bigint;
  deny: bigint;
  onChange: (allow: bigint, deny: bigint) => void;
  onRemove?: () => void;
  isEveryone?: boolean;
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
    let newAllow = allow & ~bit;
    let newDeny = deny & ~bit;
    if (state === 'allow') newAllow |= bit;
    if (state === 'deny') newDeny |= bit;
    onChange(newAllow, newDeny);
  };

  // Compact summary of non-neutral permissions
  const summary = permDefs.filter(p => getState(p.bit) !== 'neutral');

  return (
    <div className="rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-interactive-hover transition-colors"
      >
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: color || '#b9bbbe' }}
        />
        <span className="text-sm font-medium text-txt-primary flex-1 text-left truncate">{label}</span>
        {!expanded && summary.length > 0 && (
          <span className="text-[11px] text-txt-tertiary flex-shrink-0">
            {t('spaces:permissions.overrideCount', { count: summary.length })}
          </span>
        )}
        {onRemove && !isEveryone && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="p-0.5 text-txt-muted hover:text-accent-rose transition-colors"
            title={t('spaces:permissions.removeOverride')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          className={`text-txt-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-white/[0.04] pt-2">
          {permDefs.map((perm) => (
            <div key={perm.key} className="flex items-center justify-between">
              <span className="text-[13px] text-txt-secondary">{permissionNames[perm.key]}</span>
              <TriStateToggle
                value={getState(perm.bit)}
                onChange={(v) => setState(perm.bit, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
