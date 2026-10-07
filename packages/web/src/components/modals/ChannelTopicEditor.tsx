import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CHANNEL_TOPIC_MAX_LENGTH, normalizeChannelTopic } from '@backspace/shared/src/constants';

interface ChannelTopicEditorProps {
  /** The stored topic, `null` when the channel has none. */
  topic: string | null;
  /** Without it the topic is read-only text. */
  canEdit: boolean;
  /**
   * Persists the normalized topic (`null` clears it). Rejects on failure: the
   * caller shows the error, and the field keeps what was typed for a retry.
   */
  onSave: (topic: string | null) => Promise<void>;
}

/**
 * The topic field of a channel's settings Overview.
 *
 * The field always shows the stored topic until the user changes it; Save and
 * Discard Changes appear only while the normalized draft differs from it.
 * Ctrl+Enter or Cmd+Enter saves, Enter adds a line. Escape with unsaved
 * changes discards them and goes no further, so it never closes the settings
 * modal around the field (the modal listens on the document); with nothing
 * to discard, Escape reaches the modal as usual.
 *
 * Length is counted on the normalized draft, the same value and unit
 * (`CHANNEL_TOPIC_MAX_LENGTH`, UTF-16 code units) the server checks, so the
 * counter and the server never disagree. A topic stored before the limit
 * existed can be longer; it is shown whole and can only be saved once short
 * enough.
 */
export function ChannelTopicEditor({ topic, canEdit, onSave }: ChannelTopicEditorProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const [draft, setDraft] = useState(topic ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const syncedTopic = useRef(topic);
  const fieldId = useId();
  const hintId = useId();
  const limitId = useId();

  // Follow the stored topic (the server normalized what was sent, or someone
  // else changed it) unless the user has an edit of their own in progress,
  // which a remote change must not clobber.
  useEffect(() => {
    if (syncedTopic.current === topic) return;
    const previous = syncedTopic.current;
    syncedTopic.current = topic;
    setDraft((current) => (normalizeChannelTopic(current) === previous ? (topic ?? '') : current));
  }, [topic]);

  const normalizedDraft = normalizeChannelTopic(draft);
  const length = normalizedDraft?.length ?? 0;
  const tooLong = length > CHANNEL_TOPIC_MAX_LENGTH;
  const isDirty = normalizedDraft !== topic;

  if (!canEdit) {
    return (
      <div>
        <span className="block text-xs font-bold text-txt-secondary uppercase mb-2">
          {t('spaces:channel.settings.topic.label')}
        </span>
        {topic ? (
          <p className="text-sm text-txt-secondary whitespace-pre-wrap break-words">{topic}</p>
        ) : (
          <p className="text-sm text-txt-tertiary">{t('spaces:channel.settings.topic.empty')}</p>
        )}
      </div>
    );
  }

  const discard = () => {
    if (isSaving) return;
    setDraft(topic ?? '');
  };

  const save = async () => {
    if (isSaving || !isDirty || tooLong) return;
    setIsSaving(true);
    try {
      await onSave(normalizedDraft);
    } catch {
      // The caller renders the error; the typed value stays for a retry.
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void save();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && isDirty) {
      e.stopPropagation();
      discard();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  };

  const describedBy = tooLong ? `${hintId} ${limitId}` : hintId;

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor={fieldId} className="block text-xs font-bold text-txt-secondary uppercase mb-2">
        {t('spaces:channel.settings.topic.label')}
      </label>
      <textarea
        id={fieldId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        readOnly={isSaving}
        rows={3}
        maxLength={Math.max(CHANNEL_TOPIC_MAX_LENGTH, draft.length)}
        placeholder={t('spaces:channel.settings.topic.placeholder')}
        aria-describedby={describedBy}
        aria-invalid={tooLong || undefined}
        className="input-standard w-full resize-y min-h-[4.5rem] max-h-64 scrollbar-thin"
      />
      <div className="mt-1 flex items-start justify-between gap-3">
        <p id={hintId} className="text-xs text-txt-tertiary">
          {t('spaces:channel.settings.topic.hint')}
        </p>
        <span className={`flex-shrink-0 text-[11px] tabular-nums ${tooLong ? 'text-txt-danger' : 'text-txt-tertiary'}`}>
          {t('spaces:channel.settings.topic.counter', { used: length, max: CHANNEL_TOPIC_MAX_LENGTH })}
        </span>
      </div>
      {tooLong && (
        <p id={limitId} role="alert" className="mt-1 text-xs text-txt-danger">
          {t('spaces:channel.settings.topic.tooLong', { max: CHANNEL_TOPIC_MAX_LENGTH })}
        </p>
      )}
      {isDirty && (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={discard}
            disabled={isSaving}
            className="px-2.5 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
          >
            {t('spaces:channel.settings.topic.reset')}
          </button>
          <button
            type="submit"
            disabled={isSaving || tooLong}
            className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {isSaving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      )}
    </form>
  );
}
