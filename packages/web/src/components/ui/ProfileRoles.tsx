import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Role } from '@backspace/shared';

/**
 * A space member's roles on their profile card and full profile: a heading in
 * the profile's section style and one chip per role, a dot in the role colour
 * next to its name. Renders nothing for a member with no roles.
 */
export function ProfileRoles({ roles }: { roles: Role[] }) {
  const { t } = useTranslation(['social']);
  const headingId = useId();

  if (roles.length === 0) return null;

  return (
    <div>
      <span id={headingId} className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
        {t('social:profile.roles')}
      </span>
      <ul aria-labelledby={headingId} className="flex flex-wrap gap-1.5 mt-1.5">
        {roles.map((role) => (
          <li
            key={role.id}
            className="inline-flex items-center gap-1.5 max-w-full min-w-0 px-2 py-[3px] rounded-md bg-white/[0.05]"
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: role.color || '#b9bbbe' }}
              aria-hidden="true"
            />
            <span className="text-[12px] leading-[1.35] text-txt-secondary truncate">{role.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
