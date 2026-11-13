import { beforeEach, describe, expect, it } from 'vitest';
import type { Activity } from '@backspace/shared';
import {
  HIDE_BROWSER_MEDIA_KEY,
  clearHideBrowserMedia,
  isBrowserMediaActivity,
  isBrowserPlayerName,
  loadHideBrowserMedia,
  saveHideBrowserMedia,
  withoutBrowserMedia,
} from './browserMedia';

beforeEach(() => localStorage.clear());

const media = (type: Activity['type'], player: string | undefined, name = 'Song'): Activity => ({
  type,
  name,
  assets: player === undefined ? undefined : { smallText: player },
});

describe('isBrowserPlayerName', () => {
  it('recognises the names Windows SMTC and Linux MPRIS report for browsers', () => {
    for (const name of ['Chrome', 'Edge', 'Firefox', 'Brave', 'Opera', 'Vivaldi', 'Arc', 'Chromium.instance4821', 'Google-chrome', 'Microsoft-edge', 'LibreWolf']) {
      expect(isBrowserPlayerName(name), name).toBe(true);
    }
  });

  it('leaves music apps alone, including names that only contain browser letters', () => {
    for (const name of ['Spotify', 'VLC', 'Rhythmbox', 'NetEase Cloud Music', 'Yandex Music', 'Archive Player', 'Apple Music', '网易云音乐']) {
      expect(isBrowserPlayerName(name), name).toBe(false);
    }
  });

  it('treats a missing name as not a browser', () => {
    expect(isBrowserPlayerName(undefined)).toBe(false);
    expect(isBrowserPlayerName(null)).toBe(false);
    expect(isBrowserPlayerName('')).toBe(false);
  });
});

describe('withoutBrowserMedia', () => {
  const game = media('playing', 'Chrome', 'Some Game');
  const spotify = media('listening', 'Spotify');
  const tab = media('listening', 'Firefox', 'Lofi stream');
  const video = media('watching', 'Brave', 'Video');

  it('removes listening and watching activities that came from a browser', () => {
    expect(withoutBrowserMedia([spotify, tab, video], true)).toEqual([spotify]);
  });

  it('never touches games, whatever their small text says', () => {
    expect(isBrowserMediaActivity(game)).toBe(false);
    expect(withoutBrowserMedia([game, tab], true)).toEqual([game]);
  });

  it('returns the list untouched when the choice is off', () => {
    const list = [spotify, tab];
    expect(withoutBrowserMedia(list, false)).toBe(list);
  });

  it('keeps media with no player name', () => {
    const anonymous = media('listening', undefined);
    expect(withoutBrowserMedia([anonymous], true)).toEqual([anonymous]);
  });
});

describe('stored choice', () => {
  it('is off by default and round-trips', () => {
    expect(loadHideBrowserMedia()).toBe(false);
    saveHideBrowserMedia(true);
    expect(localStorage.getItem(HIDE_BROWSER_MEDIA_KEY)).toBe('1');
    expect(loadHideBrowserMedia()).toBe(true);
    saveHideBrowserMedia(false);
    expect(loadHideBrowserMedia()).toBe(false);
  });

  it('is cleared with the account', () => {
    saveHideBrowserMedia(true);
    clearHideBrowserMedia();
    expect(loadHideBrowserMedia()).toBe(false);
  });
});
