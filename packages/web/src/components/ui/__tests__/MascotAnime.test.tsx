import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Mascot, type MascotState } from '../Mascot';
import { SakuraPetals } from '../SakuraPetals';
import { useThemeStore } from '../../../stores/themeStore';

const STATES: MascotState[] = ['idle', 'sleeping', 'excited', 'lonely'];

afterEach(() => useThemeStore.setState({ theme: 'aether-drift' }));

describe('Mascot in the Anime theme', () => {
  it.each(STATES)('gives the %s pose cat ears and an ahoge', state => {
    useThemeStore.setState({ theme: 'anime' });
    const { container } = render(<Mascot state={state} />);
    expect(container.querySelectorAll('[data-anime="ear"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-anime="ahoge"]')).toHaveLength(1);
    expect(container.querySelector('[data-mascot="body"]')).toBeTruthy();
  });

  it('uses the sakura palette', () => {
    useThemeStore.setState({ theme: 'anime' });
    const { container } = render(<Mascot state="idle" />);
    const colors = Array.from(container.querySelectorAll('stop')).map(stop => stop.getAttribute('stop-color'));
    expect(colors).toContain('#ffe0ee');
    expect(colors).toContain('#f08fc0');
  });

  it.each(STATES)('adds nothing to the %s pose in other themes', state => {
    const { container } = render(<Mascot state={state} />);
    expect(container.querySelector('[data-anime]')).toBeNull();
  });
});

describe('SakuraPetals', () => {
  it('renders only in the Anime theme', () => {
    const { container, rerender } = render(<SakuraPetals />);
    expect(container.querySelector('[data-anime="petals"]')).toBeNull();
    useThemeStore.setState({ theme: 'anime' });
    rerender(<SakuraPetals />);
    expect(container.querySelector('[data-anime="petals"]')).toBeTruthy();
    expect(container.querySelectorAll('.sakura-petal').length).toBeGreaterThan(0);
  });
});
