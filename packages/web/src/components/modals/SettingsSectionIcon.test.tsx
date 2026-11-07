import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SettingsSectionIcon, type SettingsSectionIconName } from './SettingsSectionIcon';

const NAMES: SettingsSectionIconName[] = ['general', 'registration', 'federation', 'streaming', 'storage', 'users', 'updates', 'telemetry'];

describe('SettingsSectionIcon', () => {
  it('draws a decorative icon for every instance sub-section', () => {
    for (const name of NAMES) {
      const { container, unmount } = render(<SettingsSectionIcon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.children.length, name).toBeGreaterThan(0);
      unmount();
    }
  });
});
