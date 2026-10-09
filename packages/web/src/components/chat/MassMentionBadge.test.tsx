import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { InlineMessageText } from './InlineMessageText';
import { MarkdownRenderer } from './MarkdownRenderer';

// MentionBadge reads the space and UI stores at render time. Only the mention
// case touches them; stub them so the rest of the file needs no app state.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      members: [],
      roles: [{ id: 'role', spaceId: 'space-a', name: 'Maintainers', color: '#abcdef' }],
      spaces: [],
      currentSpaceId: null,
      userViews: new Map(),
      dmChannels: [],
      dmAlternatives: new Map(),
      channelToSpaceMap: new Map([['channel-a', 'space-a'], ['channel-b', 'space-b']]),
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

describe('mass mention rendering', () => {
  it('resolves role labels only in the message channel space', () => {
    const { container } = render(<MarkdownRenderer channelId="channel-a" content="<@&role>" />);
    expect(container.textContent).toBe('@Maintainers');
  });
  it('does not resolve another space role with the same id', () => {
    const { container } = render(<MarkdownRenderer channelId="channel-b" content="<@&role>" />);
    expect(container.textContent).toBe('@&role');
  });
  it('renders everyone, here and role tokens as non-profile labels', () => {
    const { container } = render(<MarkdownRenderer content="@everyone @here <@&role>" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('@everyone @here @&role');
  });
  it('keeps mass tokens literal inside code', () => {
    const { container } = render(<MarkdownRenderer content={'\x60@everyone <@&role>\x60'} />);
    expect(container.querySelector('code')?.textContent).toBe('@everyone <@&role>');
  });
  it('uses the same token and code rules for reply previews', () => {
    const { container } = render(<InlineMessageText channelId={null} content={'@here <@&role> \x60@everyone\x60'} />);
    expect(container.textContent).toBe('@here @&role \x60@everyone\x60');
    expect(container.querySelectorAll('span')).toHaveLength(2);
  });
});
