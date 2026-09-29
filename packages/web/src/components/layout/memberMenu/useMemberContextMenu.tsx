import { useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { MemberWithUser, User } from '@backspace/shared';
import { useContextMenuStore, type ContextMenuItem, type ContextMenuCheckbox } from '../../../stores/contextMenuStore';
import { getMyUserIdForOrigin, useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { PermissionBits, hasPermissionBit } from '../../../utils/permissions';
import { deliveringHost } from '../../../utils/identity';
import { viewerCanActOn, viewerCanEditMemberRoles, viewerCanManageRoleAt } from '../../../utils/roleHierarchy';
import { changeMemberRole, getCurrentMember, isRoleWritePending, subscribeMemberRoles, type MemberTarget } from './memberRoleActions';
import { friendshipMenuItems, runMemberAction, sendMemberMessage } from './memberSocialActions';
import { MemberNicknameDialog } from './MemberNicknameDialog';
import { MemberRemovalDialog } from './MemberRemovalDialog';

type MemberDialog = { target: MemberTarget; nickname: string | null; name: string; action: 'nickname' | 'kick' | 'ban' };

function roleMenuItems(target: MemberTarget): ContextMenuCheckbox[] {
  const { spaces, members, roles } = useSpaceStore.getState();
  const space = spaces.find((item) => item.id === target.spaceId);
  // Mirror the upstream hierarchy gate; the server still authorizes every write.
  return roles.filter(r => r.spaceId === target.spaceId && r.id !== target.spaceId && space && viewerCanManageRoleAt(space, members, r.position)).sort((a, b) => b.position - a.position).map(role => ({
    type: 'checkbox', key: role.id, label: role.name,
    subscribe: subscribeMemberRoles,
    getChecked: () => !!getCurrentMember(target)?.roles?.some(r => r.id === role.id),
    getDisabled: () => isRoleWritePending(target) || !getCurrentMember(target),
    onChange: checked => { void changeMemberRole(target, role.id, checked); },
  }));
}

function memberMenuPermissions(space: TaggedSpace, member: MemberWithUser) {
  const self = getMyUserIdForOrigin(space._instanceOrigin) === member.userId;
  const protectedMember = self || member.userId === space.ownerId;
  const { members, roles, spacePermissions } = useSpaceStore.getState();
  const permissions = spacePermissions.get(space.id);
  const canModerate = viewerCanActOn(space, members, member);
  const can = (bit: bigint) => hasPermissionBit(permissions, bit);
  return {
    self,
    nickname: self || (!protectedMember && can(PermissionBits.MANAGE_SPACE)),
    roles: viewerCanEditMemberRoles(space, members, roles, permissions, member),
    kick: !protectedMember && canModerate && can(PermissionBits.KICK_MEMBERS),
    ban: !protectedMember && canModerate && can(PermissionBits.BAN_MEMBERS),
  };
}

function memberSocialIdentity(target: MemberTarget, member: MemberWithUser, canonical: User): User {
  // Management uses the instance-local ID; social actions use the home address.
  return {
    ...canonical, id: member.userId, homeUserId: member.user.homeUserId ?? member.userId,
    homeInstance: member.user.homeInstance || (target.origin ? deliveringHost(target.origin) : null), username: member.user.username
  };
}

export function useMemberContextMenu(space: TaggedSpace | undefined) {
  const { t } = useTranslation(['spaces', 'social', 'common']);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<MemberDialog | null>(null);
  const spaceId = space?.id;
  const origin = space?._instanceOrigin;

  useEffect(() => {
    setDialog(null);
    // A context menu cannot keep acting on members of a space we've left.
    return () => { useContextMenuStore.getState().close(); };
  }, [spaceId, origin]);

  const open = (event: MouseEvent, member: MemberWithUser, canonical: User) => {
    event.preventDefault();
    event.stopPropagation();
    if (!space) return;
    useUIStore.getState().closeUserProfile();
    const anchor = event.currentTarget.getBoundingClientRect();
    const target = { origin: space._instanceOrigin, spaceId: space.id, userId: member.userId };
    const allowed = memberMenuPermissions(space, member);
    const showDialog = (action: MemberDialog['action']) => setDialog({
      target, action, nickname: member.nickname, name: member.nickname ?? canonical.displayName ?? canonical.username,
    });
    const user = memberSocialIdentity(target, member, canonical);
    const roles = roleMenuItems(target);
    const items: ContextMenuItem[] = [
      {
        type: 'action', key: 'profile', label: t('spaces:members.menu.profile'), onClick: () => {
          useUIStore.getState().openUserProfile(canonical, anchor, 'left', { spaceId: member.spaceId, userId: member.userId });
        }
      },
      {
        type: 'action', key: 'message', label: t('social:profile.sendMessage'), hidden: allowed.self,
        onClick: () => { void runMemberAction(() => sendMemberMessage(user, navigate)); }
      },
      ...(allowed.self ? [] : friendshipMenuItems(user, t)),
      { type: 'separator', key: 'member-separator' },
      {
        type: 'action', key: 'nickname', label: t('spaces:members.menu.nickname'), hidden: !allowed.nickname,
        onClick: () => showDialog('nickname')
      },
      {
        type: 'submenu', key: 'roles', label: t('spaces:members.menu.roles'),
        hidden: !allowed.roles || roles.length === 0,
        children: roles
      },
      { type: 'separator', key: 'moderation-separator' },
      {
        type: 'action', key: 'kick', label: t('spaces:settings.members.kick'), danger: true,
        hidden: !allowed.kick, onClick: () => showDialog('kick')
      },
      {
        type: 'action', key: 'ban', label: t('spaces:settings.members.ban'), danger: true,
        hidden: !allowed.ban, onClick: () => showDialog('ban')
      },
    ];
    useContextMenuStore.getState().open({ x: event.clientX, y: event.clientY }, items);
  };

  let dialogs = null;
  if (dialog?.action === 'nickname') {
    dialogs = <MemberNicknameDialog target={dialog.target} nickname={dialog.nickname} onClose={() => setDialog(null)} />;
  } else if (dialog) {
    dialogs = <MemberRemovalDialog target={dialog.target} action={dialog.action} name={dialog.name} onClose={() => setDialog(null)} />;
  }
  return { open, dialogs };
}
