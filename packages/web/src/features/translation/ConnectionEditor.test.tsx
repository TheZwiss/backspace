import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionEditor } from './ConnectionEditor';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const connection = {
  id: 'one',
  name: 'Personal',
  protocol: 'openai-chat' as const,
  baseUrl: 'https://api.example/v1',
  model: 'test',
  hasKey: true,
};
afterEach(cleanup);
describe('local credential editor', () => {
  it('leaves a stored key unreadable and preserves it on ordinary edits', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<ConnectionEditor connection={connection} busy={false} onSave={save} onCancel={vi.fn()} onDiagnose={vi.fn()} />);
    expect(screen.getByLabelText('apiKey')).toHaveValue('');
    expect(screen.getByLabelText('apiKey')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByText('saveConnection'));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined })));
  });
  it('blocks recipient changes until the user re-enters or explicitly clears the key', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<ConnectionEditor connection={connection} busy={false} onSave={save} onCancel={vi.fn()} onDiagnose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('baseUrl'), {
      target: { value: 'https://other.example/v1' },
    });
    expect(screen.getByText('saveConnection')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('noKey'));
    expect(screen.getByText('saveConnection')).not.toBeDisabled();
    fireEvent.click(screen.getByText('saveConnection'));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '' })));
  });
});

it('fetches models before a name/model is filled and tests the selected unsaved model', async () => {
  const diagnose = vi.fn().mockResolvedValueOnce({ ok: true, models: ['fast-chat', 'large-chat'] })
    .mockResolvedValueOnce({ ok: true, test: { latencyMs: 42, text: 'Hey, could you take a look?' } });
  const save = vi.fn();
  render(<ConnectionEditor busy={false} onSave={save} onDiagnose={diagnose} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'unsaved-secret' } });
  fireEvent.click(screen.getByText('fetchModels'));
  await screen.findByLabelText('availableModels');
  expect(diagnose).toHaveBeenCalledWith({ action: 'listModels', connection: expect.objectContaining({ apiKey: 'unsaved-secret' }) });
  expect(diagnose.mock.calls[0][0].connection).not.toHaveProperty('model');
  fireEvent.change(screen.getByLabelText('availableModels'), { target: { value: 'fast-chat' } });
  expect(screen.getByLabelText('model')).toHaveValue('fast-chat');
  fireEvent.click(screen.getByText('testConnection'));
  expect(await screen.findByText('connectionReady')).toBeInTheDocument();
  expect(diagnose).toHaveBeenLastCalledWith({ action: 'testConnection', connection: expect.objectContaining({ model: 'fast-chat', apiKey: 'unsaved-secret' }) });
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: 'https://another.example/v1' } });
  expect(screen.queryByText('connectionReady')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('availableModels')).not.toBeInTheDocument();
});
it('disables diagnostic actions after an endpoint change until a new key or keyless mode is chosen', () => {
  render(<ConnectionEditor connection={connection} busy={false} onSave={vi.fn()} onDiagnose={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: 'https://another.example/v1' } });
  expect(screen.getByText('fetchModels')).toBeDisabled();
  expect(screen.getByText('testConnection')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'new-key' } });
  expect(screen.getByText('fetchModels')).not.toBeDisabled();
  expect(screen.getByText('testConnection')).not.toBeDisabled();
});
it('shows diagnostic errors and leaves manual model input available without retrying', async () => {
  const diagnose = vi.fn().mockResolvedValue({ ok: false, code: 'http', status: 404 });
  render(<ConnectionEditor connection={connection} busy={false} onSave={vi.fn()} onDiagnose={diagnose} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByText('fetchModels'));
  expect(await screen.findByRole('alert')).toHaveTextContent('404');
  expect(screen.getByLabelText('model')).not.toBeDisabled();
  expect(diagnose).toHaveBeenCalledTimes(1);
});
it('locks the form during a live request and clears success after model edits', async () => {
  let finish!: (reply: unknown) => void;
  const diagnose = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ConnectionEditor connection={connection} busy={false} onSave={vi.fn()} onDiagnose={diagnose} onCancel={vi.fn()} />);
  fireEvent.click(screen.getByText('testConnection'));
  expect(screen.getByLabelText('baseUrl')).toBeDisabled();
  expect(screen.getByText('saveConnection')).toBeDisabled();
  finish({ ok: true, test: { latencyMs: 1, text: 'Hello!' } });
  await screen.findByText('connectionReady');
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'other' } });
  expect(screen.queryByText('connectionReady')).not.toBeInTheDocument();
});
