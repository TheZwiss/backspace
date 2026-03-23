import React, { useState } from 'react';
import type { SpaceFolder } from '@backspace/shared';
import { useSpaceStore } from '../../stores/spaceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { getSpaceGradient } from '../../utils/gradients';

const FOLDER_COLORS = [
  { name: 'Mint', value: 'rgb(var(--accent-mint))' },
  { name: 'Peach', value: 'rgb(var(--accent-peach))' },
  { name: 'Lavender', value: 'rgb(var(--accent-lavender))' },
  { name: 'Sky', value: 'rgb(var(--accent-sky))' },
  { name: 'Amber', value: 'rgb(var(--accent-amber))' },
  { name: 'Rose', value: 'rgb(var(--accent-rose))' },
  { name: 'Coral', value: 'rgb(var(--accent-coral))' },
];

interface MobileFolderSheetProps {
  folder: SpaceFolder;
  onClose: () => void;
  onSelectSpace: (spaceId: string) => void;
  onUpdateFolder: (folderId: string, updates: { name?: string | null; color?: string | null }) => void;
  onUngroup: (folderId: string) => void;
}

export function MobileFolderSheet({ folder, onClose, onSelectSpace, onUpdateFolder, onUngroup }: MobileFolderSheetProps) {
  const spaces = useSpaceStore((s) => s.spaces);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(folder.name || '');
  const openContextMenu = useContextMenuStore((s) => s.open);

  const folderSpaces = folder.spaceIds
    .map(sid => spaces.find(s => s.id === sid))
    .filter(Boolean) as typeof spaces;

  const handleRename = () => {
    const trimmed = renameValue.trim();
    onUpdateFolder(folder.id, { name: trimmed || null });
    setIsRenaming(false);
  };

  const handleFolderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY }, [
      {
        key: 'rename',
        type: 'action',
        label: 'Rename Folder',
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>,
        onClick: () => setIsRenaming(true),
      },
      {
        key: 'color',
        type: 'custom',
        render: () => (
          <div className="px-5 py-3">
            <p className="text-[11px] text-txt-tertiary mb-2">Folder Color</p>
            <div className="flex gap-2">
              <button
                className={`w-6 h-6 rounded-full border-2 ${!folder.color ? 'border-white/40' : 'border-transparent'} bg-white/10`}
                onClick={() => { onUpdateFolder(folder.id, { color: null }); useContextMenuStore.getState().close(); }}
              />
              {FOLDER_COLORS.map(c => (
                <button
                  key={c.name}
                  className={`w-6 h-6 rounded-full border-2 ${folder.color === c.value ? 'border-white/40' : 'border-transparent'}`}
                  style={{ background: c.value }}
                  onClick={() => { onUpdateFolder(folder.id, { color: c.value }); useContextMenuStore.getState().close(); }}
                />
              ))}
            </div>
          </div>
        ),
      },
      { key: 'sep', type: 'separator' },
      {
        key: 'ungroup',
        type: 'action',
        label: 'Ungroup',
        danger: true,
        icon: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>,
        onClick: () => { onUngroup(folder.id); onClose(); },
      },
    ]);
  };

  return (
    <>
      <div className="fixed inset-0 z-[300] bg-black/50" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-[301] rounded-t-2xl glass-modal animate-slide-up-sheet max-h-[60vh] flex flex-col"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />

        {/* Folder header */}
        <div className="px-4 py-2 flex items-center gap-2 shrink-0" data-context-menu onContextMenu={handleFolderContextMenu}>
          <div
            className="w-5 h-5 rounded"
            style={{ background: folder.color || 'rgb(var(--text-tertiary))' }}
          />
          {isRenaming ? (
            <input
              autoFocus
              className="input-embedded text-sm font-semibold text-txt-primary flex-1 bg-transparent"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setIsRenaming(false); }}
            />
          ) : (
            <h3 className="text-sm font-semibold text-txt-primary flex-1 truncate">
              {folder.name || 'Unnamed Folder'}
            </h3>
          )}
          <span className="text-xs text-txt-tertiary">{folderSpaces.length} spaces</span>
        </div>

        {/* Folder spaces */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {folderSpaces.map(space => {
            const iconUrl = space.icon
              ? (space.icon.startsWith('http') || space.icon.startsWith('/') ? space.icon : `/api/uploads/${space.icon}`)
              : null;
            const grad = getSpaceGradient(space.id, space.name, space.avatarColor);
            return (
              <button
                key={space.id}
                onClick={() => { onSelectSpace(space.id); onClose(); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-interactive-hover text-left transition-colors"
              >
                <div
                  className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0"
                  style={!iconUrl ? { background: grad.gradient } : undefined}
                >
                  {iconUrl ? (
                    <img src={iconUrl} alt={space.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xs font-bold text-white">{space.name.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <span className="text-sm text-txt-primary truncate">{space.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
