import { describe, expect, it } from 'vitest';
import type { MemberWithUser, Role } from '@backspace/shared';
import { composerMentions } from './composerMentions';
const members = [{ userId: '123', user: { username: 'alice', displayName: 'Alice' } }, { userId: '456', user: { username: 'other', displayName: 'Alice' } }] as MemberWithUser[];
const roles = [{ id: 'team', name: '@VIP' }] as Role[];
const model = (value: string) => composerMentions({ value, members, roles });
describe('composer mention display and wire offsets', () => {
  it('displays names without leaking IDs and keeps role prefixes singular', () => {
    expect(model('Hi <@123> <@&team> @everyone').text).toBe('Hi @Alice @VIP @everyone');
  });
  it('preserves separate IDs for identically named members', () => {
    const result = model('<@123> <@456>');
    expect(result.update('@Alice @Alice!').value).toBe('<@123> <@456>!');
  });
  it('maps cursor offsets before and after a mention', () => {
    const result = model('Hi <@123> !');
    expect(result.toWire(10)).toBe(10);
    expect(result.toDisplay(9)).toBe(9);
    expect(result.toWire(6)).toBe(3);
    expect(result.toWire(6, true)).toBe(9);
  });
  it('deletes a whole selected token with backspace rather than corrupting its ID', () => {
    expect(model('<@123> ').update('@Alic ', 5)).toEqual({ value: ' ', cursor: 0 });
    expect(model('<@123> ').update('Alice ', 0)).toEqual({ value: ' ', cursor: 0 });
  });
  it('edits ordinary text and preserves mentions around the edit', () => {
    expect(model('Hi <@123>!').update('Hey @Alice!', 3).value).toBe('Hey <@123>!');
    expect(model('<@123> hello').update('@Alice hello!', 13).value).toBe('<@123> hello!');
  });
  it('replaces a selection across mentions and supports emoji insertion', () => {
    expect(model('a <@123> b').replace({ start: 2, end: 8, text: '😀' }).value).toBe('a 😀 b');
  });
  it('does not turn pasted display names into implicit mentions', () => {
    expect(model('').update('@Alice').value).toBe('@Alice');
  });
  it('keeps code and unknown tokens literal', () => {
    const value = '\x60<@123>\x60 <@unknown>';
    expect(model(value).text).toBe(value);
    expect(model(value).parts.every(p => !p.mention)).toBe(true);
  });
});
