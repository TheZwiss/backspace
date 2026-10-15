import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComposerAction } from '@backspace/shared/translation';
import { Toggle } from '../../components/ui/Toggle';
import { getActionDisplayLabel, PRESET_COMPOSER_EXAMPLES } from './composerPresets';

interface ComposerActionEditorProps {
  actions: ComposerAction[];
  onChange: (actions: ComposerAction[]) => void;
  disabled?: boolean;
}

interface ActionFormData {
  id?: string;
  label: string;
  icon: string;
  systemPrompt: string;
}

export function ComposerActionEditor({ actions, onChange, disabled }: ComposerActionEditorProps) {
  const { t } = useTranslation('translation');
  const [editingItem, setEditingItem] = useState<ActionFormData | null>(null);
  const [showPresetsMenu, setShowPresetsMenu] = useState(false);
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);

  const handleToggle = (id: string, enabled: boolean) => {
    onChange(actions.map((a) => (a.id === id ? { ...a, enabled } : a)));
  };

  const handleDelete = (id: string) => {
    onChange(actions.filter((a) => a.id !== id));
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem || !editingItem.label.trim() || !editingItem.systemPrompt.trim()) return;

    if (editingItem.id) {
      // Editing existing action
      onChange(
        actions.map((a) =>
          a.id === editingItem.id
            ? {
                ...a,
                label: editingItem.label.trim(),
                icon: editingItem.icon.trim() || '💡',
                systemPrompt: editingItem.systemPrompt.trim(),
              }
            : a,
        ),
      );
    } else {
      // Adding new custom action
      const newAction: ComposerAction = {
        id: `custom-${Date.now()}`,
        label: editingItem.label.trim(),
        icon: editingItem.icon.trim() || '💡',
        systemPrompt: editingItem.systemPrompt.trim(),
        enabled: true,
        isCustom: true,
      };
      onChange([...actions, newAction]);
    }
    setEditingItem(null);
  };

  const handleAddPreset = (preset: (typeof PRESET_COMPOSER_EXAMPLES)[number]) => {
    // If already exists, just enable it
    const existing = actions.find((a) => a.id === preset.id);
    if (existing) {
      handleToggle(preset.id, true);
    } else {
      const newAction: ComposerAction = {
        ...preset,
        enabled: true,
      };
      onChange([...actions, newAction]);
    }
    setShowPresetsMenu(false);
  };

  const availablePresets = PRESET_COMPOSER_EXAMPLES.filter(
    (preset) => !actions.some((a) => a.id === preset.id),
  );

  return (
    <div className="space-y-3 pt-3 border-t border-white/[0.06]">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-semibold text-txt-primary">{t('composerActionsTitle')}</h4>
          <p className="text-[11px] text-txt-tertiary mt-0.5">{t('composerActionsDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          {availablePresets.length > 0 && (
            <div className="relative">
              <button
                type="button"
                disabled={disabled}
                onClick={() => setShowPresetsMenu((prev) => !prev)}
                className="rounded px-2.5 py-1 text-xs font-medium text-txt-secondary bg-white/[0.06] hover:bg-white/[0.1] transition-colors"
              >
                + {t('addPresetAction')}
              </button>
              {showPresetsMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-48 rounded-lg bg-surface-chat border border-white/[0.1] shadow-xl p-1 z-50 animate-slide-up">
                  {availablePresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleAddPreset(preset)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-txt-primary hover:bg-white/[0.08] rounded text-left transition-colors"
                    >
                      <span>{preset.icon}</span>
                      <span className="truncate">{getActionDisplayLabel(preset, t)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setEditingItem({ label: '', icon: '💡', systemPrompt: '' })}
            className="rounded px-2.5 py-1 text-xs font-medium text-accent-primary bg-accent-primary/10 hover:bg-accent-primary/20 border border-accent-primary/20 transition-colors"
          >
            + {t('addCustomAction')}
          </button>
        </div>
      </div>

      {/* Actions List */}
      <div className="space-y-2">
        {actions.map((action) => {
          const isExpanded = expandedPromptId === action.id;
          return (
            <div
              key={action.id}
              className="rounded-md bg-white/[0.02] border border-white/[0.04] p-2.5 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm shrink-0">{action.icon ?? '✨'}</span>
                  <span className="text-xs font-medium text-txt-primary truncate">
                    {getActionDisplayLabel(action, t)}
                  </span>
                  {action.isCustom ? (
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-accent-lavender/10 text-accent-lavender border border-accent-lavender/20">
                      {t('customBadge')}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      setEditingItem({
                        id: action.id,
                        label: action.label,
                        icon: action.icon ?? '💡',
                        systemPrompt: action.systemPrompt,
                      })
                    }
                    className="text-xs text-txt-tertiary hover:text-txt-primary transition-colors px-1"
                    title={t('edit')}
                  >
                    {t('edit')}
                  </button>
                  {actions.length > 1 && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleDelete(action.id)}
                      className="text-xs text-txt-danger/80 hover:text-txt-danger transition-colors px-1"
                      title={t('delete')}
                    >
                      {t('delete')}
                    </button>
                  )}
                  <Toggle
                    ariaLabel={getActionDisplayLabel(action, t)}
                    enabled={action.enabled}
                    disabled={disabled}
                    onChange={(enabled) => handleToggle(action.id, enabled)}
                  />
                </div>
              </div>

              {/* Prompt preview */}
              <div className="text-[11px] text-txt-tertiary">
                <button
                  type="button"
                  onClick={() => setExpandedPromptId(isExpanded ? null : action.id)}
                  className="hover:text-txt-secondary text-left font-mono line-clamp-1"
                >
                  {action.systemPrompt}
                </button>
                {isExpanded && (
                  <p className="mt-1 p-2 rounded bg-black/20 text-txt-secondary whitespace-pre-wrap font-sans text-[11px] leading-relaxed">
                    {action.systemPrompt}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal / Dialog for Add / Edit */}
      {editingItem && (
        <div className="fixed inset-0 z-[350] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <form
            onSubmit={handleSaveForm}
            className="w-full max-w-md rounded-xl bg-surface-chat border border-white/[0.1] shadow-2xl p-4 space-y-4 text-txt-primary animate-slide-up"
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
              <h3 className="text-sm font-semibold text-txt-primary">
                {editingItem.id ? t('editAction') : t('addCustomAction')}
              </h3>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="text-txt-tertiary hover:text-txt-primary text-xs"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-[60px_1fr] gap-2">
                <div>
                  <label className="block text-txt-secondary mb-1">{t('actionIcon')}</label>
                  <input
                    type="text"
                    maxLength={10}
                    value={editingItem.icon}
                    onChange={(e) => setEditingItem({ ...editingItem, icon: e.target.value })}
                    className="input-standard w-full text-center"
                    placeholder="💡"
                  />
                </div>
                <div>
                  <label className="block text-txt-secondary mb-1">{t('actionName')}</label>
                  <input
                    type="text"
                    required
                    maxLength={60}
                    value={editingItem.label}
                    onChange={(e) => setEditingItem({ ...editingItem, label: e.target.value })}
                    className="input-standard w-full"
                    placeholder={t('actionName')}
                  />
                </div>
              </div>

              <div>
                <label className="block text-txt-secondary mb-1">{t('actionPrompt')}</label>
                <textarea
                  required
                  rows={4}
                  maxLength={3000}
                  value={editingItem.systemPrompt}
                  onChange={(e) => setEditingItem({ ...editingItem, systemPrompt: e.target.value })}
                  className="input-standard w-full font-mono text-xs leading-relaxed resize-none"
                  placeholder={t('actionPromptPlaceholder')}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.06]">
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="px-3 py-1.5 rounded text-xs text-txt-secondary hover:bg-white/[0.06] transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded text-xs font-medium text-white bg-accent-primary hover:bg-accent-primary-hover transition-colors"
              >
                {t('save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
