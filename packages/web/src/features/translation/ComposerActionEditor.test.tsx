import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerActionEditor } from './ComposerActionEditor';
import { DEFAULT_COMPOSER_ACTIONS } from './composerPresets';
import type { ComposerAction } from '@backspace/shared/translation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ComposerActionEditor', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders configured actions list and handles toggling', () => {
    const onChange = vi.fn();
    render(
      <ComposerActionEditor
        actions={DEFAULT_COMPOSER_ACTIONS}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('composerActionsTitle')).toBeInTheDocument();
    expect(screen.getByText('polish')).toBeInTheDocument();

    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'polish', enabled: false }),
    ]);
  });

  it('adds preset example when selected', () => {
    const onChange = vi.fn();
    render(
      <ComposerActionEditor
        actions={DEFAULT_COMPOSER_ACTIONS}
        onChange={onChange}
      />,
    );

    // Open presets menu
    const addPresetBtn = screen.getByText('+ addPresetAction');
    fireEvent.click(addPresetBtn);

    // Click professional preset
    const presetItem = screen.getByText('professional');
    fireEvent.click(presetItem);

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'polish' }),
        expect.objectContaining({ id: 'professional', enabled: true }),
      ]),
    );
  });

  it('adds custom action via dialog form', () => {
    const onChange = vi.fn();
    render(
      <ComposerActionEditor
        actions={DEFAULT_COMPOSER_ACTIONS}
        onChange={onChange}
      />,
    );

    // Click add custom button
    fireEvent.click(screen.getByText('+ addCustomAction'));

    // Fill form
    fireEvent.change(screen.getByPlaceholderText('actionName'), {
      target: { value: '我的自定义动作' },
    });
    fireEvent.change(screen.getByPlaceholderText('actionPromptPlaceholder'), {
      target: { value: '请帮我写出幽默风趣的回答' },
    });

    // Submit form
    fireEvent.click(screen.getByText('save'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'polish' }),
        expect.objectContaining({
          label: '我的自定义动作',
          systemPrompt: '请帮我写出幽默风趣的回答',
          isCustom: true,
          enabled: true,
        }),
      ]),
    );
  });

  it('deletes an action when delete button is clicked and there are multiple actions', () => {
    const onChange = vi.fn();
    const initialActions: ComposerAction[] = [
      ...DEFAULT_COMPOSER_ACTIONS,
      {
        id: 'custom-1',
        label: '待删除动作',
        systemPrompt: '测试提示词',
        enabled: true,
        isCustom: true,
      },
    ];

    render(
      <ComposerActionEditor
        actions={initialActions}
        onChange={onChange}
      />,
    );

    const deleteButtons = screen.getAllByTitle('delete');
    fireEvent.click(deleteButtons[0]);

    expect(onChange).toHaveBeenCalled();
  });
});
