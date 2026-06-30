import { describe, it, expect } from 'vitest';
import { classifyVideoPlayable } from './mediaPlayable';

describe('classifyVideoPlayable', () => {
  it('marks HEVC as not web-playable regardless of container', () => {
    // macOS screen recordings: video/quicktime + hevc — the reported bug.
    expect(classifyVideoPlayable('video/quicktime', 'hevc')).toBe(false);
    // HEVC inside an mp4 container is equally undecodable in Chromium/Firefox.
    expect(classifyVideoPlayable('video/mp4', 'hevc')).toBe(false);
    // ffprobe sometimes reports the tag rather than the codec name.
    expect(classifyVideoPlayable('video/quicktime', 'hvc1')).toBe(false);
    expect(classifyVideoPlayable('video/quicktime', 'hev1')).toBe(false);
  });

  it('marks other known-undecodable codecs as not web-playable', () => {
    expect(classifyVideoPlayable('video/quicktime', 'prores')).toBe(false);
    expect(classifyVideoPlayable('video/x-msvideo', 'wmv3')).toBe(false);
  });

  it('marks web-standard codec in a web container as playable', () => {
    expect(classifyVideoPlayable('video/mp4', 'h264')).toBe(true);
    expect(classifyVideoPlayable('video/webm', 'vp9')).toBe(true);
    expect(classifyVideoPlayable('video/webm', 'av1')).toBe(true);
    // ffprobe reports H.264 as 'h264'; the mp4 box tag is 'avc1'.
    expect(classifyVideoPlayable('video/mp4', 'avc1')).toBe(true);
  });

  it('is optimistic (null) for web-safe codec in a non-web container', () => {
    // H.264 in a .mov plays in Chrome/Safari but not Firefox — let the client
    // attempt playback and fall back via onError rather than blocking it.
    expect(classifyVideoPlayable('video/quicktime', 'h264')).toBeNull();
  });

  it('is optimistic (null) when the codec is unknown', () => {
    // ffmpeg unavailable / probe failed — must not regress to "unplayable".
    expect(classifyVideoPlayable('video/mp4', undefined)).toBeNull();
    expect(classifyVideoPlayable('video/mp4', null)).toBeNull();
    expect(classifyVideoPlayable('video/mp4', '')).toBeNull();
  });

  it('returns null for non-video mimetypes', () => {
    expect(classifyVideoPlayable('audio/mpeg', 'mp3')).toBeNull();
    expect(classifyVideoPlayable('image/png', undefined)).toBeNull();
  });

  it('is case-insensitive on the codec name', () => {
    expect(classifyVideoPlayable('video/quicktime', 'HEVC')).toBe(false);
    expect(classifyVideoPlayable('video/mp4', 'H264')).toBe(true);
  });
});
