import { create } from 'zustand';
import type { MemberWithUser } from '@backspace/shared';
import { getApiForOrigin, useSpaceStore } from '../../../stores/spaceStore';
import { applySpaceMemberUpdate } from '../../../stores/spaceMemberUpdates';
import { useUIStore } from '../../../stores/uiStore';
import { describeError } from '../../../i18n/errors';

export interface MemberTarget {
  origin: string;
  spaceId: string;
  userId: string;
}
const useRoleWrites = create<{ pending: ReadonlySet<string> }>(() => ({ pending: new Set() }));
const targetKey = (target: MemberTarget) => JSON.stringify([target.origin, target.spaceId, target.userId]);

export function getCurrentMember(target: MemberTarget): MemberWithUser | undefined {
  const state = useSpaceStore.getState();
  if (state.currentSpaceId !== target.spaceId) return undefined;
  if (!state.spaces.some(s => s.id === target.spaceId && s._instanceOrigin === target.origin)) return undefined;
  return state.members.find(m => m.userId === target.userId);
}

export function isRoleWritePending(target: MemberTarget): boolean {
  return useRoleWrites.getState().pending.has(targetKey(target));
}

export function subscribeMemberRoles(listener: () => void): () => void {
  const stopMembers = useSpaceStore.subscribe(listener);
  const stopWrites = useRoleWrites.subscribe(listener);
  return () => { stopMembers(); stopWrites(); };
}

export async function changeMemberRole(target: MemberTarget, roleId: string, checked: boolean): Promise<void> {
  if (isRoleWritePending(target)) return; // Same lock as the menu's disabled state.
  const member = getCurrentMember(target);
  if (!member) return; // The menu has been invalidated by leaving this space/member.
  const roleIds = (member.roles ?? []).filter(r => r.id !== target.spaceId && r.id !== roleId).map(r => r.id);
  if (checked) roleIds.push(roleId);
  const key = targetKey(target);
  useRoleWrites.setState({ pending: new Set([...useRoleWrites.getState().pending, key]) });
  try {
    const updated = await getApiForOrigin(target.origin).spaces.updateMember(target.spaceId, target.userId, { roleIds });
    // Checkboxes change only once the server has accepted the assignment.
    applySpaceMemberUpdate(target.origin, updated);
  } catch (error) {
    useUIStore.getState().addToast(describeError(error), 'warning');
  } finally {
    const pending = new Set(useRoleWrites.getState().pending);
    pending.delete(key);
    useRoleWrites.setState({ pending });
  }
}
