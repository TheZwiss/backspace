import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface InlineNameEditorProps {
  /** The stored name: shown while not editing, and where an edit starts. */
  name: string;
  /** Leading glyph, such as a channel's # or lock or a category's folder. */
  icon: React.ReactNode;
  /** Without it the name is plain text. */
  canEdit: boolean;
  /** Names the action on the button that starts an edit ("Rename Channel"). */
  editLabel: string;
  /** Accessible name of the text field ("Channel Name"). */
  fieldLabel: string;
  maxLength: number;
  /**
   * The form the server stores a name in. An edit that normalizes to nothing,
   * or to the stored name, closes without a request.
   */
  normalize: (name: string) => string;
  /**
   * Persists the trimmed value. Rejects on failure: the caller shows the
   * error, and the editor stays open with what was typed so it can be retried.
   */
  onSave: (name: string) => Promise<void>;
}

/**
 * A settings-overview name that turns into a field on click.
 *
 * Save and Enter commit; Cancel and Escape abandon the edit; blur does
 * nothing, so a stray click elsewhere never renames anything. Escape never
 * travels past this editor: the settings modal around it closes on Escape from
 * a document listener, and an edit being abandoned must not take the modal
 * with it.
 */
export function InlineNameEditor({
  name,
  icon,
  canEdit,
  editLabel,
  fieldLabel,
  maxLength,
  normalize,
  onSave,
}: InlineNameEditorProps) {
  const { t } = useTranslation('common');
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // The store is the source of truth: follow it whenever it changes (the
  // server normalized what was sent, or someone else renamed it), but never
  // while the user is typing, which would clobber their edit.
  useEffect(() => {
    if (!isEditing) setDraft(name);
  }, [name, isEditing]);

  // Keep the keyboard inside the editor across a save. The field and buttons
  // go inert while the request runs, and a disabled element cannot hold focus,
  // so it would fall to <body>, where an Escape reaches the modal's document
  // listener and closes it around the running request. The form holds focus
  // for the duration and hands it back to the field if the save failed. A
  // layout effect, so there is no frame in which <body> has focus.
  useLayoutEffect(() => {
    if (isSaving) {
      formRef.current?.focus();
      return;
    }
    if (formRef.current && document.activeElement === formRef.current) {
      inputRef.current?.focus();
    }
  }, [isSaving]);

  // When an edit ends, give focus back to the button that started it.
  useLayoutEffect(() => {
    if (wasEditing.current && !isEditing) editButtonRef.current?.focus();
    wasEditing.current = isEditing;
  }, [isEditing]);

  const startEditing = () => {
    setDraft(name);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    if (isSaving) return;
    setDraft(name);
    setIsEditing(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    const next = normalize(draft);
    if (!next || next === name) {
      cancelEditing();
      return;
    }
    setIsSaving(true);
    try {
      await onSave(draft.trim());
      setIsEditing(false);
    } catch {
      // The caller renders the error; the typed value stays for a retry.
    } finally {
      setIsSaving(false);
    }
  };

  // Stopped first and judged after, so nothing above can act on it. During a
  // save it is swallowed, the same as Cancel, which is disabled then.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    cancelEditing();
  };

  return (
    <div className="flex items-center gap-2 text-txt-primary">
      {icon}
      {!canEdit ? (
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
      ) : isEditing ? (
        <form
          ref={formRef}
          tabIndex={-1}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2 outline-none"
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            disabled={isSaving}
            autoFocus
            aria-label={fieldLabel}
            maxLength={maxLength}
            className="input-standard min-w-0 flex-1 py-1.5 px-2 text-sm"
          />
          <button
            type="submit"
            disabled={isSaving}
            className="flex-shrink-0 px-2.5 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {isSaving ? t('states.saving') : t('actions.save')}
          </button>
          <button
            type="button"
            onClick={cancelEditing}
            disabled={isSaving}
            className="flex-shrink-0 px-2 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
          >
            {t('actions.cancel')}
          </button>
        </form>
      ) : (
        <button
          ref={editButtonRef}
          type="button"
          onClick={startEditing}
          title={editLabel}
          className="group -mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 text-left text-sm font-medium transition-colors hover:bg-interactive-hover"
        >
          <span className="min-w-0 truncate">{name}</span>
          <span className="sr-only">{editLabel}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className="flex-shrink-0 text-txt-tertiary opacity-70 transition-opacity group-hover:opacity-100"
          >
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
          </svg>
        </button>
      )}
    </div>
  );
}
