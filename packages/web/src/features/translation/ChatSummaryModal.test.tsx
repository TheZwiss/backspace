import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSummaryModal, summaryCache } from './ChatSummaryModal';
import type { MessageWithUser } from '@backspace/shared';
import { useChatStore } from '../../stores/chatStore';
import * as translationStore from './translationStore';

let mockLanguage = 'en';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: mockLanguage, resolvedLanguage: mockLanguage },
  }),
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn(() => ({})),
  },
}));

vi.mock('./useMessageTranslation', () => ({
  useTranslationSettings: () => ({
    accountId: 'user-1',
    settings: {
      revision: 1,
      connections: [{ id: 'conn-1', name: 'OpenAI', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasKey: true }],
      preferences: {
        defaultConnection: 'conn-1',
        engine: null,
        targetLanguage: 'zh-CN',
        consent: true,
        automatic: false,
        showOriginal: true,
        summarizerEnabled: true,
      },
    },
  }),
}));

describe('ChatSummaryModal', () => {
  beforeEach(() => {
    mockLanguage = 'en';
    summaryCache.clear();
    useChatStore.setState({
      messages: new Map([
        [
          'channel-1',
          [
            {
              id: '1',
              channelId: 'channel-1',
              userId: 'u1',
              content: '今天讨论一下新功能上线的时间表',
              createdAt: Date.now() - 10000,
              user: { id: 'u1', username: 'alice', displayName: 'Alice' },
            } as unknown as MessageWithUser,
            {
              id: '2',
              channelId: 'channel-1',
              userId: 'u2',
              content: '我认为下周二发布比较稳妥',
              createdAt: Date.now() - 5000,
              user: { id: 'u2', username: 'bob', displayName: 'Bob' },
            } as unknown as MessageWithUser,
          ],
        ],
      ]),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('generates and renders summary for eligible messages', async () => {
    vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValueOnce({
      ok: true,
      outputText: '1. 核心讨论：讨论新功能发布时间。\n2. 达成的共识：暂定下周二上线。',
    });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-1"
        channelName="general"
      />
    );

    expect(await screen.findByText(/核心讨论：讨论新功能发布时间/)).toBeInTheDocument();
    expect(screen.getByText('copySummary')).toBeInTheDocument();
  });

  it('shows empty message notice when channel has no text messages', async () => {
    useChatStore.setState({ messages: new Map([['channel-empty', []]]) });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-empty"
        channelName="empty-channel"
      />
    );

    expect(await screen.findByText('noMessagesToSummarize')).toBeInTheDocument();
  });

  it('does not exceed update depth when channel messages are unpopulated in store', () => {
    useChatStore.setState({ messages: new Map() });

    const { rerender } = render(
      <ChatSummaryModal
        isOpen={false}
        onClose={vi.fn()}
        channelId="unloaded-channel-1"
        channelName="unloaded-1"
      />
    );

    // Switching channels while messages are still unloaded
    expect(() => {
      rerender(
        <ChatSummaryModal
          isOpen={false}
          onClose={vi.fn()}
          channelId="unloaded-channel-2"
          channelName="unloaded-2"
        />
      );
    }).not.toThrow();
  });

  it('supports switching between unread and date modes with language instructions', async () => {
    const spy = vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValue({
      ok: true,
      outputText: '日期摘要内容',
    });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-1"
        channelName="general"
      />
    );

    // Initial unread mode
    expect(screen.getByText(/summaryModeUnread/)).toBeInTheDocument();
    expect(screen.getByText(/summaryModeDate/)).toBeInTheDocument();

    // Initial render auto-generates with language instruction
    expect(await screen.findByText('日期摘要内容')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'aiGenerate',
        systemPrompt: expect.stringContaining('strictly in English'),
      }),
    );

    // Switch to date mode - should NOT automatically trigger generation
    fireEvent.click(screen.getByText(/summaryModeDate/));
    expect(spy).toHaveBeenCalledTimes(1);

    // User explicitly clicks 'generateSummary'
    fireEvent.click(screen.getByText('generateSummary'));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });

    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'aiGenerate',
        userPrompt: expect.stringContaining('messages from'),
      }),
    );
  });

  it('reuses cached summary on date switch to avoid duplicate AI requests and saves tokens, re-requesting only on regenerate', async () => {
    const spy = vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValue({
      ok: true,
      outputText: '第一次生成的日期摘要内容',
    });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-1"
        channelName="general"
      />
    );

    // Initial unread auto-generate call
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Switch to date mode
    fireEvent.click(screen.getByText(/summaryModeDate/));
    expect(spy).toHaveBeenCalledTimes(1);

    // User explicitly clicks 'generateSummary' for today
    fireEvent.click(screen.getByText('generateSummary'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('第一次生成的日期摘要内容')).toBeInTheDocument();

    // Switch to unread mode (which was already cached from the first call)
    fireEvent.click(screen.getByText(/summaryModeUnread/));
    // Should immediately display cached unread summary without additional AI call
    expect(spy).toHaveBeenCalledTimes(2);

    // Switch back to date mode (which was cached from the second call)
    fireEvent.click(screen.getByText(/summaryModeDate/));
    // Should immediately display cached date summary without additional AI call!
    expect(screen.getByText('第一次生成的日期摘要内容')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);

    // Now user explicitly clicks 'regenerate'
    spy.mockResolvedValueOnce({
      ok: true,
      outputText: '第二次重新生成的日期摘要内容',
    });
    fireEvent.click(screen.getByText('regenerate'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(3);
    });
    expect(await screen.findByText('第二次重新生成的日期摘要内容')).toBeInTheDocument();
  });

  it('formats summary language requirement strictly according to the current global language', async () => {
    mockLanguage = 'zh';
    const spy = vi.spyOn(translationStore, 'sendTranslationCommand').mockResolvedValue({
      ok: true,
      outputText: '中文摘要内容',
    });

    render(
      <ChatSummaryModal
        isOpen={true}
        onClose={vi.fn()}
        channelId="channel-1"
        channelName="general"
      />
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'aiGenerate',
          systemPrompt: expect.stringContaining('strictly in Simplified Chinese'),
        }),
      );
    });
  });
});

