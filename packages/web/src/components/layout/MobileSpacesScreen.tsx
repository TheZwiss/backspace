import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getMyUserIdForOrigin } from '../../stores/spaceStore';
import type { TaggedSpace } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { useNavigate } from 'react-router-dom';
import { getSpaceGradient } from '../../utils/gradients';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import type { Channel, SpaceFolder } from '@backspace/shared';
import { Mascot } from '../ui/Mascot';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TransferOwnershipModal } from '../modals/TransferOwnershipModal';
import { MobileFolderSheet } from './MobileFolderSheet';
import { useInstanceStore } from '../../stores/instanceStore';
import { VoiceUserRow } from '../voice/VoiceUserRow';
import { MobileVoiceJoinSheet } from '../voice/MobileVoiceJoinSheet';
import { buildVoiceModMenuItems, VolumeSliderItem } from '../voice/voiceMenuItems';
import { joinVoiceChannel } from '../../utils/voice';

type ResolvedItem =
  | { type: 'space'; space: TaggedSpace }
  | { type: 'folder'; folder: SpaceFolder; spaces: TaggedSpace[] };

export function MobileSpacesScreen() {
  const spaces = useSpaceStore((s) => s.spaces);
  const channels = useSpaceStore((s) => s.channels);
  const categories = useSpaceStore((s) => s.categories);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const voiceChannelIds = useSpaceStore((s) => s.voiceChannelIds);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const channelPermissions = useSpaceStore((s) => s.channelPermissions);
  const folders = useSpaceStore((s) => s.folders);
  const spaceLayout = useSpaceStore((s) => s.spaceLayout);
  const updateSpaceLayout = useSpaceStore((s) => s.updateSpaceLayout);

  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);

  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const participantMutes = useVoiceStore((s) => s.participantMutes);
  const speakingUserIds = useVoiceStore((s) => s.speakingUserIds);

  const members = useSpaceStore((s) => s.members);

  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const setMobileTab = useUIStore((s) => s.setMobileTab);
  const openModal = useUIStore((s) => s.openModal);
  const setLastChannel = useUIStore((s) => s.setLastChannel);
  const addToast = useUIStore((s) => s.addToast);

  const openContextMenu = useContextMenuStore((s) => s.open);

  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  // Local state
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(currentSpaceId);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [leaveConfirmSpaceId, setLeaveConfirmSpaceId] = useState<string | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [transferModalSpaceId, setTransferModalSpaceId] = useState<string | null>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [voiceJoinChannelId, setVoiceJoinChannelId] = useState<string | null>(null);

  // Sync selected space with store's current space
  useEffect(() => {
    if (selectedSpaceId) {
      setCurrentSpace(selectedSpaceId);
      loadSpaceDetail(selectedSpaceId);
    }
  }, [selectedSpaceId, setCurrentSpace, loadSpaceDetail]);

  // Auto-select first space if none selected
  useEffect(() => {
    if (!selectedSpaceId && spaces.length > 0 && spaces[0]) {
      setSelectedSpaceId(spaces[0].id);
    }
  }, [selectedSpaceId, spaces]);

  // Check if loaded channels belong to selected space
  const spaceChannels = useMemo(() => {
    if (!selectedSpaceId) return [];
    return channels.filter(c => channelToSpaceMap.get(c.id) === selectedSpaceId);
  }, [channels, channelToSpaceMap, selectedSpaceId]);

  // Group channels by category
  const channelsByCategory = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const ch of spaceChannels) {
      if (!ch.categoryId) continue;
      let arr = map.get(ch.categoryId);
      if (!arr) { arr = []; map.set(ch.categoryId, arr); }
      arr.push(ch);
    }
    for (const [key, arr] of map) {
      map.set(key, arr.sort((a, b) => a.position - b.position));
    }
    return map;
  }, [spaceChannels]);

  const uncategorizedChannels = useMemo(() =>
    spaceChannels
      .filter(c => !c.categoryId)
      .sort((a, b) => a.position - b.position),
    [spaceChannels]
  );

  const sortedCategories = useMemo(() =>
    [...categories].sort((a, b) => a.position - b.position),
    [categories]
  );

  // Check if space has unread text channels
  const spaceHasUnread = (spaceId: string): boolean => {
    for (const chId of unreadChannels) {
      if (channelToSpaceMap.get(chId) === spaceId && !voiceChannelIds.has(chId)) {
        return true;
      }
    }
    return false;
  };

  // ─── Folder-aware layout resolution ─────────────────────────────────

  const spaceMap = useMemo(() => new Map(spaces.map(s => [s.id, s])), [spaces]);
  const folderMap = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);

  const resolvedLayout = useMemo((): ResolvedItem[] => {
    const result: ResolvedItem[] = [];
    const accountedSpaceIds = new Set<string>();

    if (spaceLayout && spaceLayout.length > 0) {
      for (const item of spaceLayout) {
        if (item.t === 's') {
          const space = spaceMap.get(item.id);
          if (space) {
            result.push({ type: 'space', space });
            accountedSpaceIds.add(item.id);
          }
        } else if (item.t === 'f') {
          const folder = folderMap.get(item.id);
          if (folder) {
            const folderSpaces = folder.spaceIds
              .map(sid => spaceMap.get(sid))
              .filter((s): s is TaggedSpace => !!s);
            if (folderSpaces.length > 0) {
              result.push({ type: 'folder', folder, spaces: folderSpaces });
              for (const s of folderSpaces) accountedSpaceIds.add(s.id);
            }
          }
        }
      }
    }

    for (const space of spaces) {
      if (!accountedSpaceIds.has(space.id)) {
        result.push({ type: 'space', space });
      }
    }

    return result;
  }, [spaceLayout, spaces, spaceMap, folderMap]);

  const handleSpaceSelect = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    setCollapsedCategories(new Set());
  };

  const handleChannelTap = (channel: Channel) => {
    if (channel.type === 'voice') {
      setVoiceJoinChannelId(channel.id);
      return;
    }
    if (selectedSpaceId) {
      setLastChannel(selectedSpaceId, channel.id);
      navigate(`/channels/${selectedSpaceId}/${channel.id}`);
    }
    pushMobileScreen('channel-chat', {
      channelId: channel.id,
      spaceId: selectedSpaceId || '',
    });
  };

  const handleVoiceJoin = useCallback((chId: string, preMuted: boolean) => {
    if (preMuted) {
      useVoiceStore.getState().setMuted(true);
    }
    const connectFn = useVoiceStore.getState().connectFn;
    joinVoiceChannel(chId, connectFn ?? undefined);
    setVoiceJoinChannelId(null);
    pushMobileScreen('voice');
  }, [pushMobileScreen]);

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  // ─── Folder handlers ──────────────────────────────────────────────────

  const handleCreateFolder = async (spaceId: string) => {
    const currentLayout = spaceLayout || spaces.map(s => ({ t: 's' as const, id: s.id }));
    // Remove the space from its current position
    const newLayout = currentLayout.filter(item => !(item.t === 's' && item.id === spaceId));
    // Create a new folder ID
    const folderId = `folder-${Date.now()}`;
    // Insert the folder where the space was
    const insertIdx = currentLayout.findIndex(item => item.t === 's' && item.id === spaceId);
    newLayout.splice(insertIdx >= 0 ? insertIdx : newLayout.length, 0, { t: 'f', id: folderId });

    const folderData: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    // Preserve existing folders
    for (const f of folders) {
      folderData[f.id] = { name: f.name, color: f.color, spaceIds: f.spaceIds };
    }
    // Add new folder
    folderData[folderId] = { name: null, color: null, spaceIds: [spaceId] };

    await updateSpaceLayout(newLayout, folderData);
    addToast('Folder created', 'success', 3000);
  };

  const handleMoveToFolder = async (spaceId: string, folderId: string) => {
    const currentLayout = spaceLayout || spaces.map(s => ({ t: 's' as const, id: s.id }));
    const newLayout = currentLayout.filter(item => !(item.t === 's' && item.id === spaceId));

    const folderData: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      folderData[f.id] = {
        name: f.name,
        color: f.color,
        spaceIds: f.id === folderId ? [...f.spaceIds, spaceId] : f.spaceIds,
      };
    }

    await updateSpaceLayout(newLayout, folderData);
    addToast('Moved to folder', 'success', 3000);
  };

  const handleRemoveFromFolder = async (spaceId: string) => {
    const currentLayout = spaceLayout || spaces.map(s => ({ t: 's' as const, id: s.id }));

    // Find which folder contains this space
    const containingFolder = folders.find(f => f.spaceIds.includes(spaceId));
    if (!containingFolder) return;

    // Find the folder's position in layout and insert the space after it
    const folderIdx = currentLayout.findIndex(item => item.t === 'f' && item.id === containingFolder.id);
    const newLayout = [...currentLayout];
    newLayout.splice(folderIdx + 1, 0, { t: 's', id: spaceId });

    const folderData: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      folderData[f.id] = {
        name: f.name,
        color: f.color,
        spaceIds: f.id === containingFolder.id
          ? f.spaceIds.filter(sid => sid !== spaceId)
          : f.spaceIds,
      };
    }

    // If folder is now empty, remove it from layout
    if (folderData[containingFolder.id]!.spaceIds.length === 0) {
      const idx = newLayout.findIndex(item => item.t === 'f' && item.id === containingFolder.id);
      if (idx >= 0) newLayout.splice(idx, 1);
      delete folderData[containingFolder.id];
    }

    await updateSpaceLayout(newLayout, folderData);
    addToast('Removed from folder', 'success', 3000);
  };

  const handleUngroup = async (folderId: string) => {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    const currentLayout = spaceLayout || spaces.map(s => ({ t: 's' as const, id: s.id }));
    const folderIdx = currentLayout.findIndex(item => item.t === 'f' && item.id === folderId);

    // Replace folder with its spaces
    const newLayout = [...currentLayout];
    const spaceItems = folder.spaceIds.map(sid => ({ t: 's' as const, id: sid }));
    newLayout.splice(folderIdx, 1, ...spaceItems);

    const folderData: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      if (f.id !== folderId) {
        folderData[f.id] = { name: f.name, color: f.color, spaceIds: f.spaceIds };
      }
    }

    await updateSpaceLayout(newLayout, folderData);
    setOpenFolderId(null);
    addToast('Folder ungrouped', 'success', 3000);
  };

  const handleUpdateFolder = async (folderId: string, updates: { name?: string | null; color?: string | null }) => {
    const folderData: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};
    for (const f of folders) {
      folderData[f.id] = {
        name: f.id === folderId && updates.name !== undefined ? updates.name : f.name,
        color: f.id === folderId && updates.color !== undefined ? updates.color : f.color,
        spaceIds: f.spaceIds,
      };
    }
    const currentLayout = spaceLayout || spaces.map(s => ({ t: 's' as const, id: s.id }));
    await updateSpaceLayout(currentLayout, folderData);
  };

  // ─── Context menu handlers ────────────────────────────────────────────

  const handleSpaceContextMenu = (e: React.MouseEvent, spaceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const space = spaces.find(s => s.id === spaceId);
    if (!space) return;
    const isOwner = space.ownerId === getMyUserIdForOrigin((space as TaggedSpace)._instanceOrigin ?? '');

    // Check if space is in a folder
    const inFolder = folders.some(f => f.spaceIds.includes(spaceId));
    const availableFolders = folders.filter(f => !f.spaceIds.includes(spaceId));

    const items: ContextMenuItem[] = [
      {
        key: 'invite',
        type: 'action',
        label: 'Invite People',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" /></svg>,
        onClick: async () => {
          try {
            const code = await useSpaceStore.getState().generateInvite(spaceId);
            const origin = (space as TaggedSpace)._instanceOrigin || window.location.origin;
            const url = `${origin}/invite/${code}`;
            await navigator.clipboard.writeText(url);
            addToast('Invite link copied to clipboard', 'success', 3000);
          } catch {
            addToast('Failed to generate invite', 'warning', 3000);
          }
        },
      },
      {
        key: 'create-folder',
        type: 'action',
        label: 'Create Folder',
        hidden: inFolder,
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>,
        onClick: () => handleCreateFolder(spaceId),
      },
    ];

    // Move to Folder submenu (only for standalone spaces when folders exist)
    if (!inFolder && availableFolders.length > 0) {
      items.push({
        key: 'move-to-folder',
        type: 'submenu',
        label: 'Move to Folder',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>,
        children: availableFolders.map(f => ({
          key: f.id,
          type: 'action' as const,
          label: f.name || 'Unnamed Folder',
          onClick: () => handleMoveToFolder(spaceId, f.id),
        })),
      });
    }

    // Remove from Folder (only for spaces in a folder)
    if (inFolder) {
      items.push({
        key: 'remove-from-folder',
        type: 'action',
        label: 'Remove from Folder',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>,
        onClick: () => handleRemoveFromFolder(spaceId),
      });
    }

    items.push({ key: 'sep', type: 'separator' });

    items.push({
      key: 'transfer',
      type: 'action',
      label: 'Transfer Ownership',
      hidden: !isOwner,
      icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>,
      onClick: () => setTransferModalSpaceId(spaceId),
    });

    items.push({
      key: 'leave',
      type: 'action',
      label: 'Leave Space',
      hidden: isOwner,
      danger: true,
      icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" /></svg>,
      onClick: () => setLeaveConfirmSpaceId(spaceId),
    });

    openContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  const handleChannelContextMenu = (e: React.MouseEvent, channelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const canManageChannels = hasPermissionBit(
      channelPermissions.get(channelId),
      PermissionBits.MANAGE_CHANNELS
    );
    if (!canManageChannels) return;

    const items: ContextMenuItem[] = [
      {
        key: 'channel-settings',
        type: 'action',
        label: 'Channel Settings',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
        onClick: () => openModal('channelSettings', { channelId }),
      },
      { key: 'ch-sep', type: 'separator' },
      {
        key: 'delete-channel',
        type: 'action',
        label: 'Delete Channel',
        danger: true,
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>,
        onClick: () => setDeleteChannelId(channelId),
      },
    ];

    openContextMenu({ x: e.clientX, y: e.clientY }, items);
  };

  const handleCategoryContextMenu = (e: React.MouseEvent, categoryId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const canManageChannels = hasPermissionBit(myPerms, PermissionBits.MANAGE_CHANNELS);
    if (!canManageChannels) return;

    openContextMenu({ x: e.clientX, y: e.clientY }, [
      {
        key: 'category-settings',
        type: 'action',
        label: 'Category Settings',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
        onClick: () => openModal('categorySettings', { categoryId }),
      },
      { key: 'cat-sep', type: 'separator' },
      {
        key: 'delete-category',
        type: 'action',
        label: 'Delete Category',
        danger: true,
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>,
        onClick: () => setDeleteCategoryId(categoryId),
      },
    ]);
  };

  const selectedSpace = spaces.find(s => s.id === selectedSpaceId);
  const myPerms = selectedSpaceId ? spacePermissions.get(selectedSpaceId) : undefined;
  const canInvite = hasPermissionBit(myPerms, PermissionBits.CREATE_INVITE);
  const canManageSpace = hasPermissionBit(myPerms, PermissionBits.MANAGE_SPACE);

  const handleVoiceUserContextMenu = useCallback(
    (e: React.MouseEvent, userId: string, channelId: string) => {
      if (userId === user?.id) return;
      e.preventDefault();
      e.stopPropagation();

      const modItems = buildVoiceModMenuItems(userId, channelId);
      const items: ContextMenuItem[] = [...modItems];

      if (modItems.length > 0) {
        items.push({ key: 'mod-end-sep', type: 'separator' });
      }

      items.push({
        key: 'mute-user',
        type: 'checkbox',
        label: 'Mute User',
        subscribe: useVoiceStore.subscribe,
        getChecked: () => useVoiceStore.getState().participantMutes.get(userId) ?? false,
        onChange: (checked) => useVoiceStore.getState().setParticipantMute(userId, checked),
      });

      items.push({ key: 'vol-sep', type: 'separator' });

      items.push({
        key: 'volume',
        type: 'custom',
        render: () => React.createElement(VolumeSliderItem, { userId }),
      });

      openContextMenu({ x: e.clientX, y: e.clientY }, items);
    },
    [user?.id, openContextMenu],
  );

  const renderChannelItem = (channel: Channel) => {
    const isVoice = channel.type === 'voice';
    const isActive = !isVoice && currentChannelId === channel.id;
    const isUnread = unreadChannels.has(channel.id) && !isActive;
    const isInVoice = currentVoiceChannelId === channel.id;
    const vUsers = voiceUsers.get(channel.id) || [];
    const canView = hasPermissionBit(channelPermissions.get(channel.id), PermissionBits.VIEW_CHANNEL);
    if (canView === false) return null;

    const spaceId = channelToSpaceMap.get(channel.id);

    return (
      <div key={channel.id}>
        <button
          onClick={() => handleChannelTap(channel)}
          onContextMenu={(e) => handleChannelContextMenu(e, channel.id)}
          data-context-menu={`channel-${channel.id}`}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
            isActive ? 'bg-interactive-selected text-txt-primary' :
            isInVoice ? 'bg-accent-mint/10 text-accent-mint' :
            'text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary'
          }`}
        >
          {isVoice ? (
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
          ) : (
            <span className="text-sm shrink-0 opacity-60">#</span>
          )}
          <span className={`flex-1 text-sm truncate ${isUnread ? 'font-semibold text-txt-primary' : ''}`}>
            {channel.name}
          </span>
          {isUnread && <span className="w-2 h-2 rounded-full bg-txt-primary shrink-0" />}
        </button>

        {/* Inline voice users */}
        {isVoice && vUsers.length > 0 && (
          <div className="ml-7 mt-0.5 space-y-0.5">
            {vUsers.map((userId) => {
              const member = members.find(m => m.userId === userId);
              const displayName = member?.user.displayName ?? member?.user.username ?? userId;
              const avatar = member?.user.avatar ?? null;
              const avatarColor = member?.user.avatarColor;
              const wsStatus = voiceUserStates.get(userId);
              const isMuted = wsStatus?.isMuted ?? false;
              const isDeafened = wsStatus?.isDeafened ?? false;
              const hasCamera = wsStatus?.isCameraOn ?? false;
              const isScreenSharing = wsStatus?.isScreenSharing ?? false;
              const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${userId}`);
              const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${userId}`);
              const isPermissionMuted = permissionMutedUserIds.has(`${spaceId}:${userId}`);

              return (
                <div
                  key={userId}
                  data-context-menu={`voice-user-${userId}`}
                  className="px-3 py-1 rounded-lg hover:bg-interactive-hover transition-colors"
                  onClick={() => openModal('userProfile', { userId: member?.user.homeUserId ?? userId })}
                  onContextMenu={(e) => handleVoiceUserContextMenu(e, userId, channel.id)}
                >
                  <VoiceUserRow
                    userId={member?.user.homeUserId ?? userId}
                    displayName={displayName}
                    avatar={avatar}
                    avatarColor={avatarColor ?? undefined}
                    isMuted={isMuted}
                    isDeafened={isDeafened}
                    isCameraOn={hasCamera}
                    isScreenSharing={isScreenSharing}
                    isServerMuted={isSpaceMuted}
                    isServerDeafened={isSpaceDeafened}
                    isPermissionMuted={isPermissionMuted}
                    isLocallyMuted={userId !== user?.id && (participantMutes.get(userId) ?? false)}
                    isSpeaking={speakingUserIds.has(userId)}
                    size="compact"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full">
      {/* Space strip */}
      <div className="w-[60px] shrink-0 glass-strip flex flex-col items-center py-2 gap-1.5 overflow-y-auto no-scrollbar">
        {/* Home / DMs button */}
        <button
          onClick={() => {
            setMobileTab('dms');
            navigate('/channels/@me');
          }}
          className="w-10 h-10 rounded-2xl bg-surface-elevated flex items-center justify-center text-txt-secondary hover:text-txt-primary hover:bg-accent-primary transition-all"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        </button>

        <div className="w-8 h-px bg-border-soft my-0.5" />

        {/* Space icons (folder-aware) */}
        {resolvedLayout.map((item) => {
          if (item.type === 'folder') {
            const folder = item.folder;
            const hasUnread = item.spaces.some(s => spaceHasUnread(s.id));
            const isSelected = item.spaces.some(s => s.id === selectedSpaceId);
            return (
              <div key={`folder-${folder.id}`} className="relative">
                <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 flex items-center">
                  <div className={`bg-white rounded-r-full transition-all duration-200 w-full ${
                    isSelected ? 'h-8' : hasUnread ? 'h-2' : 'h-0'
                  }`} />
                </div>
                <button
                  onClick={() => setOpenFolderId(folder.id)}
                  onContextMenu={(e) => e.preventDefault()}
                  className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
                    isSelected ? 'rounded-xl ring-2 ring-accent-primary/50' : 'hover:rounded-xl'
                  } bg-surface-elevated`}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke={folder.color || 'currentColor'} strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                </button>
              </div>
            );
          }

          // Standalone space — full space icon rendering with federation badge and context menu
          const space = item.space;
          const isSelected = space.id === selectedSpaceId;
          const hasUnread = spaceHasUnread(space.id);
          const iconUrl = space.icon
            ? (space.icon.startsWith('http') || space.icon.startsWith('/')
                ? space.icon
                : `/api/uploads/${space.icon}`)
            : null;
          const grad = getSpaceGradient(space.id, space.name, space.avatarColor);

          return (
            <div key={space.id} className="relative">
              {/* Unread / selected pill */}
              <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 flex items-center">
                <div
                  className={`bg-white rounded-r-full transition-all duration-200 w-full ${
                    isSelected ? 'h-8' : hasUnread ? 'h-2' : 'h-0'
                  }`}
                />
              </div>
              <button
                data-context-menu
                onClick={() => handleSpaceSelect(space.id)}
                onContextMenu={(e) => handleSpaceContextMenu(e, space.id)}
                className={`w-10 h-10 rounded-2xl overflow-hidden flex items-center justify-center transition-all ${
                  isSelected ? 'rounded-xl ring-2 ring-accent-primary/50' : 'hover:rounded-xl'
                }`}
                style={!iconUrl ? { background: grad.gradient } : undefined}
              >
                {iconUrl ? (
                  <img src={iconUrl} alt={space.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[15px] font-bold text-white">
                    {space.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </button>
              {(() => {
                const origin = (space as TaggedSpace)._instanceOrigin;
                if (!origin) return null;
                const instances = useInstanceStore.getState().instances;
                const inst = instances.find(i => i.origin === origin);
                const isDisconnected = inst ? inst.status !== 'connected' : false;
                return (
                  <div className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full bg-surface-base flex items-center justify-center">
                    {isDisconnected ? (
                      <div className="w-[8px] h-[8px] rounded-full bg-accent-amber" />
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                      </svg>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}

        <div className="w-8 h-px bg-border-soft my-0.5" />

        {/* Add space button */}
        <button
          onClick={() => setShowAddSheet(true)}
          className="w-10 h-10 rounded-2xl bg-surface-elevated flex items-center justify-center text-accent-mint hover:bg-accent-mint/10 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 flex flex-col min-w-0 bg-surface-channel">
        {/* Space header */}
        {selectedSpace && (
          <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
            <h1 className="flex-1 text-sm font-semibold text-txt-primary truncate">
              {selectedSpace.name}
            </h1>
            {canInvite && (
              <button
                onClick={() => openModal('invite', { spaceId: selectedSpaceId })}
                className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
                </svg>
              </button>
            )}
            {canManageSpace && (
              <button
                onClick={() => openModal('spaceSettings', { spaceId: selectedSpaceId })}
                className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            )}
          </header>
        )}

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {/* Uncategorized channels */}
          {uncategorizedChannels.map(renderChannelItem)}

          {/* Categorized channels */}
          {sortedCategories.map(category => {
            const catChannels = channelsByCategory.get(category.id) || [];
            if (catChannels.length === 0) return null;
            const isCollapsed = collapsedCategories.has(category.id);

            return (
              <div key={category.id} className="mt-3">
                <button
                  data-context-menu
                  onClick={() => toggleCategory(category.id)}
                  onContextMenu={(e) => handleCategoryContextMenu(e, category.id)}
                  className="flex items-center gap-1 px-1 py-1 w-full text-left"
                >
                  <svg
                    className={`w-3 h-3 text-txt-tertiary transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary truncate">
                    {category.name}
                  </span>
                </button>
                {!isCollapsed && catChannels.map(renderChannelItem)}
              </div>
            );
          })}

          {/* Empty state */}
          {spaceChannels.length === 0 && selectedSpaceId && (
            <div className="flex flex-col items-center justify-center h-32 opacity-80">
              <Mascot state="idle" className="w-20 h-20 mb-2" />
              <p className="text-txt-tertiary text-sm">No channels yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Add Space bottom sheet */}
      {showAddSheet && (
        <>
          <div className="fixed inset-0 z-[300] bg-black/50" onClick={() => setShowAddSheet(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 z-[301] rounded-t-2xl glass-bubble animate-slide-up-sheet"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
            <div className="py-2">
              <button
                onClick={() => { setShowAddSheet(false); openModal('createSpace'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-sm text-txt-primary">Create Space</span>
              </button>
              <button
                onClick={() => { setShowAddSheet(false); openModal('joinSpace'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-sky" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                <span className="text-sm text-txt-primary">Join Space</span>
              </button>
              <button
                onClick={() => { setShowAddSheet(false); pushMobileScreen('explore'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-lavender" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span className="text-sm text-txt-primary">Explore Spaces</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Confirmation dialogs */}
      {leaveConfirmSpaceId && (
        <ConfirmDialog
          isOpen={true}
          title="Leave Space"
          description="Are you sure you want to leave this space? You'll need a new invite to rejoin."
          confirmLabel="Leave"
          variant="danger"
          onConfirm={async () => {
            try {
              await useSpaceStore.getState().leaveSpace(leaveConfirmSpaceId);
              if (selectedSpaceId === leaveConfirmSpaceId) setSelectedSpaceId(null);
              addToast('Left space', 'success', 3000);
            } catch {
              addToast('Failed to leave space', 'warning', 3000);
            }
            setLeaveConfirmSpaceId(null);
          }}
          onClose={() => setLeaveConfirmSpaceId(null)}
        />
      )}

      {deleteChannelId && (
        <ConfirmDialog
          isOpen={true}
          title="Delete Channel"
          description="Are you sure? This will permanently delete the channel and all its messages."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            try {
              await useSpaceStore.getState().deleteChannel(deleteChannelId);
              addToast('Channel deleted', 'success', 3000);
            } catch {
              addToast('Failed to delete channel', 'warning', 3000);
            }
            setDeleteChannelId(null);
          }}
          onClose={() => setDeleteChannelId(null)}
        />
      )}

      {deleteCategoryId && (
        <ConfirmDialog
          isOpen={true}
          title="Delete Category"
          description="Are you sure? Channels in this category will be moved to uncategorized."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={async () => {
            try {
              await useSpaceStore.getState().deleteCategory(deleteCategoryId);
              addToast('Category deleted', 'success', 3000);
            } catch {
              addToast('Failed to delete category', 'warning', 3000);
            }
            setDeleteCategoryId(null);
          }}
          onClose={() => setDeleteCategoryId(null)}
        />
      )}

      {transferModalSpaceId && (
        <TransferOwnershipModal
          spaceId={transferModalSpaceId}
          onClose={() => setTransferModalSpaceId(null)}
        />
      )}

      {openFolderId && (() => {
        const folder = folders.find(f => f.id === openFolderId);
        if (!folder) return null;
        return (
          <MobileFolderSheet
            folder={folder}
            onClose={() => setOpenFolderId(null)}
            onSelectSpace={(spaceId) => {
              handleSpaceSelect(spaceId);
            }}
            onUpdateFolder={handleUpdateFolder}
            onUngroup={handleUngroup}
          />
        );
      })()}

      {voiceJoinChannelId && selectedSpaceId && (
        <MobileVoiceJoinSheet
          channelId={voiceJoinChannelId}
          channelName={channels.find(c => c.id === voiceJoinChannelId)?.name || ''}
          spaceId={selectedSpaceId}
          onClose={() => setVoiceJoinChannelId(null)}
          onJoin={handleVoiceJoin}
        />
      )}
    </div>
  );
}
