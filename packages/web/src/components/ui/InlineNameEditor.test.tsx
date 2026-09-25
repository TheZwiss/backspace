import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { normalizeChannelName } from '@backspace/shared/src/constants';
import { InlineNameEditor } from './InlineNameEditor';
import { Modal } from './Modal';

function setup(opts: { canEdit?: boolean; onSave?: (name: string) => Promise<void> } = {}) {
  const onSave = vi.fn(opts.onSave ?? (() => Promise.resolve()));
  const onClose = vi.fn();
  const user = userEvent.setup();
  // Inside a real Modal: it closes on Escape from a document listener, which
  // is exactly what an Escape meant for the editor must never reach.
  render(
    <Modal isOpen onClose={onClose} title="Settings">
      <InlineNameEditor
        name="general"
        icon={<span>#</span>}
        canEdit={opts.canEdit ?? true}
        editLabel="Rename Channel"
        fieldLabel="Channel Name"
        maxLength={100}
        normalize={normalizeChannelName}
        onSave={onSave}
      />
      <button type="button">elsewhere</button>
    </Modal>,
  );
  return { onSave, onClose, user };
}

const field = () => screen.getByRole('textbox', { name: 'Channel Name' });
const startEdit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /Rename Channel/ }));

describe('InlineNameEditor', () => {
  it('shows plain text and no edit control without permission', () => {
    setup({ canEdit: false });
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rename Channel/ })).toBeNull();
  });

  it('Enter saves the trimmed value and closes the editor', async () => {
    const { onSave, user } = setup();
    await startEdit(user);
    await user.clear(field());
    await user.type(field(), '  announcements  {Enter}');
    expect(onSave).toHaveBeenCalledWith('announcements');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('Escape abandons the edit without closing the modal', async () => {
    const { onSave, onClose, user } = setup();
    await startEdit(user);
    await user.type(field(), '-typed');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // With the editor closed, the modal owns Escape again.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('swallows Escape while a save is running', async () => {
    let finish: () => void = () => {};
    const { onClose, user } = setup({ onSave: () => new Promise<void>((resolve) => { finish = resolve; }) });
    await startEdit(user);
    await user.clear(field());
    await user.type(field(), 'renamed{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('closes without a request when the edit normalizes to the stored name', async () => {
    const { onSave, user } = setup();
    await startEdit(user);
    await user.clear(field());
    await user.type(field(), ' General {Enter}');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the typed value and the focus after a failed save', async () => {
    const { user } = setup({ onSave: () => Promise.reject(new Error('refused')) });
    await startEdit(user);
    await user.clear(field());
    await user.type(field(), 'renamed{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect((field() as HTMLInputElement).value).toBe('renamed');
  });

  it('does nothing on blur, and Cancel abandons the edit', async () => {
    const { onSave, user } = setup();
    await startEdit(user);
    await user.type(field(), '-typed');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect((field() as HTMLInputElement).value).toBe('general-typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('general')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
