import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { getApiForOrigin, useSpaceStore } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { describeError } from '../../../i18n/errors';
import { getCurrentMember, type MemberTarget } from './memberRoleActions';

export function MemberRemovalDialog({ target, action, name, onClose }: {
  target: MemberTarget;
  action: 'kick' | 'ban';
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('spaces');
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const confirm = async () => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    try {
      const api = getApiForOrigin(target.origin);
      if (action === 'kick') await api.spaces.removeMember(target.spaceId, target.userId);
      else await api.spaces.ban(target.spaceId, target.userId);
      if (getCurrentMember(target)) useSpaceStore.getState().removeMember(target.spaceId, target.userId);
      onClose();
    } catch (error) {
      useUIStore.getState().addToast(describeError(error), 'warning');
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  return <ConfirmDialog isOpen onClose={() => { if (!writing.current) onClose(); }} onConfirm={() => void confirm()}
    title={t(action === 'kick' ? 'settings.members.confirm.kickTitle' : 'settings.members.confirm.banTitle', { name })}
    description={t(action === 'kick' ? 'settings.members.confirm.kickDescription' : 'settings.members.confirm.banDescription', { name })}
    confirmLabel={t(action === 'kick' ? 'settings.members.kick' : 'settings.members.ban')} variant="danger" loading={saving} />;
}
