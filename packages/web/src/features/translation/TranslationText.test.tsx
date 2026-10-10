import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationText } from './TranslationText';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const translated = {
  anchorRef: createRef<HTMLDivElement>(),
  translate: vi.fn(),
  showOriginal: true,
  cacheKey: 'message-1',
  entry: {
    state: 'done' as const,
    automatic: false,
    result: { kind: 'translated' as const, text: '你好' },
  },
};
afterEach(cleanup);
describe('local-only translation presentation', () => {
  it('shows source plus translation in WeChat-style mode', () => {
    render(
      <TranslationText translation={translated}>
        <p>Hello</p>
      </TranslationText>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
  });
  it('replaces visible body in Telegram-style mode and can reveal the unmodified source', () => {
    render(
      <TranslationText translation={{ ...translated, showOriginal: false }}>
        <p>Hello</p>
      </TranslationText>,
    );
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
    fireEvent.click(screen.getByText('viewOriginal'));
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByText('你好')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('viewTranslation'));
    expect(screen.getByText('你好')).toBeInTheDocument();
  });
  it('renders model-generated HTML, links, images and mentions as inert text', () => {
    const malicious = '<img src="https://bad.example/pixel"> ![leak](https://bad.example) <@everyone>';
    const translation = {
      ...translated,
      entry: {
        ...translated.entry,
        result: { kind: 'translated' as const, text: malicious },
      },
    };
    const { container } = render(
      <TranslationText translation={translation}>
        <p>Hello</p>
      </TranslationText>,
    );
    expect(screen.getByTestId('message-translation').textContent).toBe(malicious);
    expect(container.querySelector('img, a, script')).toBeNull();
  });
  it('never hides the source when translation fails', () => {
    render(
      <TranslationText
        translation={{
          ...translated,
          showOriginal: false,
          entry: { state: 'error', error: { ok: false, code: 'network' } },
        }}
      >
        <p>Hello</p>
      </TranslationText>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
