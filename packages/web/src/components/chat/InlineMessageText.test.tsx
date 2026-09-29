import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { InlineMessageText } from './InlineMessageText';

// MentionBadge reads the space and UI stores at render time; stub them so the
// test needs no app state.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      members: [],
      spaces: [],
      currentSpaceId: null,
      userViews: new Map(),
      dmChannels: [],
      dmAlternatives: new Map(),
      channelToSpaceMap: new Map(),
      channelOriginMap: new Map(),
    }),
  getApiForOrigin: vi.fn(),
  getMyUserIdForOrigin: vi.fn(),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: null }),
}));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ openUserProfile: vi.fn() }),
}));
vi.mock('../../api/client', () => ({
  api: {},
  createApiClient: vi.fn(),
}));

describe('InlineMessageText', () => {
  it('renders mention tokens as badges', () => {
    const { container } = render(<InlineMessageText channelId="chan-1" content={'hi <@U1> there'} />);
    expect(container.textContent).toBe('hi @Unknown User there');
  });

  it('renders emoji shortcodes as emoji, as the full message does (issue #252)', () => {
    const { container } = render(<InlineMessageText channelId="chan-1" content={'on fire :heart_on_fire: <@U1>'} />);
    expect(container.textContent).toBe('on fire ❤️‍🔥 @Unknown User');
  });

  it('leaves shortcodes inside code spans as written', () => {
    const { container } = render(<InlineMessageText channelId="chan-1" content={'use `:smile:` for :smile:'} />);
    expect(container.textContent).toBe('use `:smile:` for 😄');
  });

  it('leaves a mention token inside a code span as written, as the full message does', () => {
    const { container } = render(<InlineMessageText channelId="chan-1" content={'type `<@U1>` to ping <@U1>'} />);
    expect(container.textContent).toBe('type `<@U1>` to ping @Unknown User');
  });
});
