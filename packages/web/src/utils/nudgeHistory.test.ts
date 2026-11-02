import { describe, expect, it } from 'vitest';
import { parseDmSystemEvent } from '@backspace/shared/src/dmSystemEvents';
import { dmSystemIcon, dmSystemText } from './dmFormatters';
import { setLanguage } from '../i18n';

describe('nudge history', () => {
  it('validates persisted effects without executing them', () => {
    expect(parseDmSystemEvent('{"event":"nudge","effect":"msn_fart_guy"}')).toEqual({ event: 'nudge', effect: 'msn_fart_guy' });
    expect(parseDmSystemEvent('{"event":"nudge","effect":"invalid"}')).toBeNull();
    expect(parseDmSystemEvent('{"event":"nudge"}')).toBeNull();
  });
  it('shows the sender and localized effect in the timeline and preview', async () => {
    await setLanguage('pt');
    try {
      const event = { event: 'nudge', effect: 'knock' } as const;
      expect(dmSystemIcon(event)).toBe('🔔');
      for (const form of ['timeline', 'preview'] as const) {
        const text = dmSystemText(event, 'Alice', form);
        expect(text).toContain('Alice chamou a atenção');
        expect(text).not.toContain('chat:');
      }
    } finally { await setLanguage('en'); }
  });
});
