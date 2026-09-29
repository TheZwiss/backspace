import { useTranslation } from 'react-i18next';
import type { ProfileMemberContext } from '../../stores/uiStore';
import { useProfileMember } from '../../hooks/useProfileMember';

/** A space-scoped label; the profile's global account name stays unchanged. */
export function ProfileSpaceNickname({ member }: { member: ProfileMemberContext | null | undefined }) {
  const { t } = useTranslation('spaces');
  const spaceMember = useProfileMember(member);
  if (!spaceMember?.nickname) return null;
  return <div className="mb-1 text-sm text-txt-secondary">{t('members.nickname.label')}: {spaceMember.nickname}</div>;
}
