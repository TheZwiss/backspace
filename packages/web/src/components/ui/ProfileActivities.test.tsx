import { render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { ProfileActivities } from './ProfileActivities';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
});

afterEach(async () => {
  await setLanguage('en');
  vi.useRealTimers();
});

describe('ProfileActivities', () => {
  it('returns null when activities array is empty', () => {
    const { container } = render(<ProfileActivities activities={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a Game card when user is playing a game', () => {
    const game: Activity = {
      type: 'playing',
      name: 'Cyberpunk 2077',
      details: 'Night City',
      timestamps: { start: Date.now() - 3600 * 1000 },
    };

    render(<ProfileActivities activities={[game]} />);
    expect(screen.getByText('Playing a Game')).toBeInTheDocument();
    expect(screen.getByText('Cyberpunk 2077')).toBeInTheDocument();
    expect(screen.getByText('Night City')).toBeInTheDocument();
  });

  it('renders a Streaming card when user is streaming', () => {
    const streaming: Activity = {
      type: 'streaming',
      name: 'OBS Studio',
      details: 'Live on Twitch',
      timestamps: { start: Date.now() - 1800 * 1000 },
    };

    render(<ProfileActivities activities={[streaming]} />);
    expect(screen.getByText('Streaming')).toBeInTheDocument();
    expect(screen.getByText('OBS Studio')).toBeInTheDocument();
    expect(screen.getByText('Live on Twitch')).toBeInTheDocument();
  });

  it('renders rich Music card with player badge, artist, and track link, and localizes player name', async () => {
    const now = Date.now();
    const music: Activity = {
      type: 'listening',
      name: '海阔天空',
      details: 'Beyond',
      state: '光辉岁月精选',
      assets: {
        smallText: '网易云音乐',
        largeImage: 'https://example.com/cover.jpg',
      },
      timestamps: {
        start: now - 60 * 1000,
        end: now + 240 * 1000,
      },
      url: 'https://music.163.com/#/song?id=186016',
    };

    const { rerender } = render(<ProfileActivities activities={[music]} />);
    expect(screen.getByText('Listening to Music')).toBeInTheDocument();
    expect(screen.getByText('NetEase Cloud Music')).toBeInTheDocument();
    expect(screen.getByText('海阔天空')).toBeInTheDocument();
    expect(screen.getByText('Beyond')).toBeInTheDocument();
    expect(screen.getByText('光辉岁月精选')).toBeInTheDocument();
    expect(screen.getByText('Open Track')).toBeInTheDocument();
    expect(screen.getByText('Open Track').closest('a')).toHaveAttribute(
      'href',
      'https://music.163.com/#/song?id=186016',
    );

    await setLanguage('zh');
    rerender(<ProfileActivities activities={[music]} />);
    expect(screen.getByText('正在收听')).toBeInTheDocument();
    expect(screen.getByText('网易云音乐')).toBeInTheDocument();
    await setLanguage('en');
  });

  it('renders rich Watching card with progress bar for media videos (e.g. Chrome video)', () => {
    const now = Date.now();
    const video: Activity = {
      type: 'watching',
      name: 'Rick Astley - Never Gonna Give You Up',
      details: 'YouTube',
      timestamps: {
        start: now - 60 * 1000,
        end: now + 152 * 1000,
      },
      url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    };

    render(<ProfileActivities activities={[video]} />);
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('Rick Astley - Never Gonna Give You Up')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText('01:00')).toBeInTheDocument();
    expect(screen.getByText('03:32')).toBeInTheDocument();
    expect(screen.getByText('Open Track').closest('a')).toHaveAttribute('href', 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('renders all concurrent activities: streaming, multiple games, and music', () => {
    const stream: Activity = {
      type: 'streaming',
      name: 'OBS Studio',
      details: 'Live stream',
    };
    const game1: Activity = {
      type: 'playing',
      name: 'Counter-Strike 2',
      timestamps: { start: Date.now() - 3600 * 1000 },
    };
    const game2: Activity = {
      type: 'playing',
      name: 'Elden Ring',
    };
    const music: Activity = {
      type: 'listening',
      name: 'Starboy',
      details: 'The Weeknd',
      assets: { smallText: 'Spotify' },
    };

    render(<ProfileActivities activities={[stream, game1, game2, music]} />);
    expect(screen.getByText('Streaming')).toBeInTheDocument();
    expect(screen.getByText('OBS Studio')).toBeInTheDocument();
    expect(screen.getByText('Counter-Strike 2')).toBeInTheDocument();
    expect(screen.getByText('1h 0m elapsed')).toBeInTheDocument();
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Starboy')).toBeInTheDocument();
    expect(screen.getByText('Spotify')).toBeInTheDocument();
  });

  it('respects skipCustom prop', () => {
    const custom: Activity = {
      type: 'custom',
      name: 'coding hard :rocket:',
    };

    const { rerender } = render(<ProfileActivities activities={[custom]} skipCustom={true} />);
    expect(screen.queryByText(/coding hard/)).not.toBeInTheDocument();

    rerender(<ProfileActivities activities={[custom]} skipCustom={false} />);
    expect(screen.getByText('coding hard 🚀')).toBeInTheDocument();
  });

  it('renders elapsed time text only without progress bar or live badge for music without end duration', () => {
    const now = Date.now();
    const music: Activity = {
      type: 'listening',
      name: '晴天',
      details: '周杰伦',
      assets: {
        smallText: 'NetEase Cloud Music',
      },
      timestamps: {
        start: now - 35 * 1000,
      },
      playback: {
        positionMs: 35 * 1000,
      },
    };

    render(<ProfileActivities activities={[music]} />);
    expect(screen.getByText('晴天')).toBeInTheDocument();
    expect(screen.getByText('周杰伦')).toBeInTheDocument();
    expect(screen.getByText('NetEase Cloud Music')).toBeInTheDocument();
    expect(screen.getByText('00:35 elapsed')).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-progress-bar')).not.toBeInTheDocument();
  });
});
