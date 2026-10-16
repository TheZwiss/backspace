import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSION_GROUPS, type PermissionGroupId } from '../../utils/permissionGroups';
import { permissionsToString, stringToPermissions } from '../../utils/permissions';
import { usePermissionNames } from './OverrideEntry';

/**
 * Checkboxes over permission bits, grouped as in the role editor. Used where
 * a bot's permissions are chosen without a role in hand: the owner picking
 * what the bot asks for (Settings > Bots), and a manager picking what to
 * grant when adding it to a space (bots.md, "Permissions on invite").
 *
 * Values are decimal bitmask strings, as everywhere in the client.
 */
interface BotPermissionChecklistProps {
  /** The bits offered; groups with none of them are left out. */
  offered: string;
  /** The bits ticked. */
  value: string;
  onChange: (value: string) => void;
  /** Bits shown but not switchable (for example ones the viewer does not hold). */
  locked?: string;
  disabled?: boolean;
}

export function BotPermissionChecklist({ offered, value, onChange, locked = '0', disabled = false }: BotPermissionChecklistProps) {
  const { t } = useTranslation(['spaces']);
  const names = usePermissionNames();
  const idPrefix = useId();
  const offeredBits = stringToPermissions(offered);
  const valueBits = stringToPermissions(value);
  const lockedBits = stringToPermissions(locked);

  const groupTitle = (id: PermissionGroupId): string => {
    switch (id) {
      case 'general': return t('spaces:roles.groups.general');
      case 'text': return t('spaces:roles.groups.text');
      case 'voice': return t('spaces:roles.groups.voice');
    }
  };

  const toggle = (bit: bigint) => {
    onChange(permissionsToString((valueBits & bit) !== 0n ? valueBits & ~bit : valueBits | bit));
  };

  return (
    <div className="space-y-3">
      {PERMISSION_GROUPS.map((group) => {
        const perms = group.perms.filter((perm) => (offeredBits & perm.bit) !== 0n);
        if (perms.length === 0) return null;
        return (
          <fieldset key={group.id} className="min-w-0">
            <legend className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
              {groupTitle(group.id)}
            </legend>
            <div className="space-y-1">
              {perms.map((perm) => {
                const id = `${idPrefix}-${perm.key}`;
                const isLocked = disabled || (lockedBits & perm.bit) !== 0n;
                return (
                  <label
                    key={perm.key}
                    htmlFor={id}
                    className={`flex items-center gap-2 text-sm ${isLocked ? 'opacity-50 cursor-default' : 'cursor-pointer'}`}
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={(valueBits & perm.bit) !== 0n}
                      disabled={isLocked}
                      onChange={() => toggle(perm.bit)}
                      className="w-3.5 h-3.5 rounded border-txt-tertiary accent-accent-primary flex-shrink-0"
                    />
                    <span className="text-txt-primary">{names[perm.key]}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
