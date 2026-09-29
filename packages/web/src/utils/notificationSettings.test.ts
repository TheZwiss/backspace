import { describe, it, expect } from 'vitest';
import type { NotificationSetting } from '@backspace/shared';
import { MUTED_FOREVER } from '@backspace/shared';
import { isMessageAlert, type MessageAlertInput } from './notificationFilters';
import { parseMentions, hasMassMention } from '@backspace/shared/src/mentions';

const base: MessageAlertInput = { authorUserId: 'other', myIds: new Set(['me', 'remote-me']), isDmChannel: false, content: '<@me>', allChannels: true, now: 1000 };
const setting: NotificationSetting = { targetType: 'space', targetId: 'space', level: null, mutedUntil: null, suppressEveryone: false, suppressRoles: false };

describe('notification inheritance and mute boundaries', () => {
  it.each([1001, MUTED_FOREVER])('space mute %s beats channel overrides, mentions and every-message sounds', mutedUntil => {
    expect(isMessageAlert({ ...base, spaceSetting: { ...setting, mutedUntil }, channelSetting: { ...setting, level: 'all' } })).toBe(false);
  });
  it('a channel can mute without muting its space', () => {
    expect(isMessageAlert({ ...base, channelSetting: { ...setting, mutedUntil: MUTED_FOREVER } })).toBe(false);
    expect(isMessageAlert(base)).toBe(true);
  });
  it('expires precisely at mutedUntil and keeps the configured level', () => {
    expect(isMessageAlert({ ...base, spaceSetting: { ...setting, mutedUntil: 1000 } })).toBe(true);
    expect(isMessageAlert({ ...base, content: 'normal', spaceSetting: { ...setting, mutedUntil: 1000, level: 'mentions' } })).toBe(false);
  });
  it('explicit levels override the local all-messages sound preference', () => {
    expect(isMessageAlert({ ...base, spaceSetting: { ...setting, level: 'nothing' } })).toBe(false);
    expect(isMessageAlert({ ...base, content: 'normal', spaceSetting: { ...setting, level: 'mentions' } })).toBe(false);
    expect(isMessageAlert({ ...base, allChannels: false, content: 'normal', channelSetting: { ...setting, level: 'all' } })).toBe(true);
  });
  it('channels inherit space levels and can explicitly override them', () => {
    expect(isMessageAlert({ ...base, spaceSetting: { ...setting, level: 'nothing' }, channelSetting: setting })).toBe(false);
    expect(isMessageAlert({ ...base, spaceSetting: { ...setting, level: 'nothing' }, channelSetting: { ...setting, level: 'mentions' } })).toBe(true);
  });
  it('does not change DM delivery or self-message filtering', () => {
    expect(isMessageAlert({ ...base, isDmChannel: true, spaceSetting: { ...setting, mutedUntil: MUTED_FOREVER } })).toBe(true);
    expect(isMessageAlert({ ...base, authorUserId: 'remote-me' })).toBe(false);
  });
});

describe('mention filters', () => {
  const mentions = { ...base, allChannels: false, roleIds: new Set(['my-role']) };
  it.each(['@everyone', '@here'])('recognizes %s and suppresses it independently of direct mentions', content => {
    expect(isMessageAlert({ ...mentions, content })).toBe(true);
    expect(isMessageAlert({ ...mentions, content, spaceSetting: { ...setting, suppressEveryone: true } })).toBe(false);
    expect(isMessageAlert({ ...mentions, content: content + ' <@remote-me>', spaceSetting: { ...setting, suppressEveryone: true } })).toBe(true);
  });
  it('only alerts for roles held by this user', () => {
    expect(isMessageAlert({ ...mentions, content: '<@&my-role>' })).toBe(true);
    expect(isMessageAlert({ ...mentions, content: '<@&other-role>' })).toBe(false);
    expect(isMessageAlert({ ...mentions, content: '<@&my-role>', spaceSetting: { ...setting, suppressRoles: true } })).toBe(false);
  });
  it('ignores code and does not mistake a role for a user', () => {
    expect(parseMentions('`<@me> @everyone`').userIds.size).toBe(0);
    expect(hasMassMention('```\n@here <@&role>\n```')).toBe(false);
    expect(parseMentions('<@&me>').userIds.size).toBe(0);
    expect(hasMassMention('mail@everyone.com @everyoneElse')).toBe(false);
  });
});
