import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHANNEL_TOPIC_MAX_LENGTH } from '@backspace/shared/src/constants';
import { ChannelTopicEditor } from './ChannelTopicEditor';
import { Modal } from '../ui/Modal';

function setup(opts: {
  topic?: string | null;
  canEdit?: boolean;
  onSave?: (topic: string | null) => Promise<void>;
} = {}) {
  const onSave = vi.fn(opts.onSave ?? (() => Promise.resolve()));
  const onClose = vi.fn();
  const user = userEvent.setup();
  const topic = opts.topic === undefined ? 'Old topic' : opts.topic;
  const ui = (value: string | null) => (
    // Inside a real Modal, which closes on Escape from a document listener.
    <Modal isOpen onClose={onClose} title="Settings">
      <ChannelTopicEditor topic={value} canEdit={opts.canEdit ?? true} onSave={onSave} />
    </Modal>
  );
  const view = render(ui(topic));
  return { onSave, onClose, user, rerender: (value: string | null) => view.rerender(ui(value)) };
}

const field = () => screen.getByRole('textbox', { name: 'Topic' });
const saveButton = () => screen.queryByRole('button', { name: 'Save' });

describe('ChannelTopicEditor', () => {
  it('shows the stored topic as read-only text without permission', () => {
    setup({ topic: 'Line one\nLine two', canEdit: false });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Line one/)).toBeInTheDocument();
  });

  it('says there is no topic when read-only and empty', () => {
    setup({ topic: null, canEdit: false });
    expect(screen.getByText('No topic set.')).toBeInTheDocument();
  });

  it('shows Save only once the normalized value differs from the stored topic', async () => {
    const { user } = setup();
    expect(field()).toHaveValue('Old topic');
    expect(saveButton()).toBeNull();
    await user.type(field(), '   ');
    expect(saveButton()).toBeNull();
    await user.type(field(), '!');
    expect(saveButton()).not.toBeNull();
  });

  it('saves the normalized topic', async () => {
    const { onSave, user } = setup();
    await user.clear(field());
    await user.type(field(), '  Be kind{Enter}No spam  ');
    await user.click(saveButton()!);
    expect(onSave).toHaveBeenCalledWith('Be kind\nNo spam');
  });

  it('saves null when the topic is cleared', async () => {
    const { onSave, user } = setup();
    await user.clear(field());
    await user.click(saveButton()!);
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('Ctrl+Enter saves, Enter alone adds a line', async () => {
    const { onSave, user } = setup({ topic: null });
    await user.type(field(), 'a{Enter}b');
    expect(onSave).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSave).toHaveBeenCalledWith('a\nb');
  });

  it('Escape discards unsaved changes without closing the modal', async () => {
    const { onSave, onClose, user } = setup();
    await user.type(field(), ' more');
    await user.keyboard('{Escape}');
    expect(field()).toHaveValue('Old topic');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // With nothing left to discard, the modal owns Escape again.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the typed value when saving fails', async () => {
    const { user } = setup({ onSave: () => Promise.reject(new Error('nope')) });
    await user.clear(field());
    await user.type(field(), 'New topic');
    await user.click(saveButton()!);
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(field()).toHaveValue('New topic');
  });

  it('counts characters against the shared limit', async () => {
    const { user } = setup({ topic: null });
    await user.type(field(), '  abc  ');
    expect(screen.getByText(`3/${CHANNEL_TOPIC_MAX_LENGTH}`)).toBeInTheDocument();
  });

  it('shows a stored topic longer than the limit whole, and blocks saving until it is short enough', async () => {
    const longTopic = 'x'.repeat(CHANNEL_TOPIC_MAX_LENGTH + 5);
    const { onSave, user } = setup({ topic: longTopic });
    expect(field()).toHaveValue(longTopic);
    await user.type(field(), '{Backspace}');
    expect(screen.getByRole('alert')).toHaveTextContent(String(CHANNEL_TOPIC_MAX_LENGTH));
    expect(saveButton()).toBeDisabled();
    await user.type(field(), '{Backspace}{Backspace}{Backspace}{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(saveButton()!);
    expect(onSave).toHaveBeenCalledWith('x'.repeat(CHANNEL_TOPIC_MAX_LENGTH));
  });

  it('follows a stored topic changed elsewhere while there is no edit', () => {
    const { rerender } = setup();
    rerender('Changed elsewhere');
    expect(field()).toHaveValue('Changed elsewhere');
  });

  it('keeps an edit in progress when the stored topic changes elsewhere', async () => {
    const { user, rerender } = setup();
    await user.clear(field());
    await user.type(field(), 'Mine');
    rerender('Changed elsewhere');
    expect(field()).toHaveValue('Mine');
  });
});
