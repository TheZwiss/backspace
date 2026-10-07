import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';

interface ChannelHeaderTopicProps {
  channelName: string;
  topic: string;
}

/**
 * A text channel's topic in the channel header.
 *
 * The header has room for one line, so the topic is cut to it with an
 * ellipsis. The full text is never out of reach: hovering shows it in the
 * native tooltip, and the line is a button that opens it in a dialog, which
 * also serves keyboard and touch users and keeps the topic's line breaks.
 */
export function ChannelHeaderTopic({ channelName, topic }: ChannelHeaderTopicProps) {
  const { t } = useTranslation('spaces');
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <div className="w-[1px] h-5 bg-border-soft mx-2 flex-shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title={topic}
        aria-haspopup="dialog"
        className="min-w-0 truncate rounded-[4px] px-1 -mx-1 text-left text-[13px] leading-tight text-txt-tertiary transition-colors hover:text-txt-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        <span className="sr-only">{t('main.topic.show')}</span>{' '}
        {topic}
      </button>
      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={t('main.topic.dialogTitle', { name: channelName })}
        maxWidth="max-w-lg"
        mobileStyle="sheet"
      >
        <p className="text-sm text-txt-secondary whitespace-pre-wrap break-words">{topic}</p>
      </Modal>
    </>
  );
}
