// packages/web/src/components/ui/__tests__/Mascot.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Mascot } from '../Mascot';

// Mock the animation hook — Task 2 implements it
vi.mock('../../../hooks/useMascotAnimation', () => ({
  useMascotAnimation: vi.fn(),
}));

describe('Mascot', () => {
  it('renders an SVG with aria-hidden and presentation role', () => {
    const { container } = render(<Mascot state="idle" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('role')).toBe('presentation');
    const svg = wrapper.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies idle palette gradient stops', () => {
    const { container } = render(<Mascot state="idle" />);
    const stops = container.querySelectorAll('stop');
    const colors = Array.from(stops).map(s => s.getAttribute('stop-color'));
    expect(colors).toContain('#c8f0de');
    expect(colors).toContain('#6dbf96');
  });

  it('applies sleeping palette gradient stops', () => {
    const { container } = render(<Mascot state="sleeping" />);
    const stops = container.querySelectorAll('stop');
    const colors = Array.from(stops).map(s => s.getAttribute('stop-color'));
    expect(colors).toContain('#ddd4f0');
    expect(colors).toContain('#a898cc');
  });

  it('applies excited palette gradient stops', () => {
    const { container } = render(<Mascot state="excited" />);
    const stops = container.querySelectorAll('stop');
    const colors = Array.from(stops).map(s => s.getAttribute('stop-color'));
    expect(colors).toContain('#fde0c8');
    expect(colors).toContain('#e8a870');
  });

  it('applies lonely palette gradient stops', () => {
    const { container } = render(<Mascot state="lonely" />);
    const stops = container.querySelectorAll('stop');
    const colors = Array.from(stops).map(s => s.getAttribute('stop-color'));
    expect(colors).toContain('#c0dced');
    expect(colors).toContain('#78aec8');
  });

  it('renders upright viewBox for idle state', () => {
    const { container } = render(<Mascot state="idle" />);
    const svg = container.querySelector('svg');
    expect(svg!.getAttribute('viewBox')).toBe('0 0 200 200');
  });

  it('renders wide viewBox for sleeping state', () => {
    const { container } = render(<Mascot state="sleeping" />);
    const svg = container.querySelector('svg');
    expect(svg!.getAttribute('viewBox')).toBe('0 0 220 130');
  });

  it('renders closed-eye arcs (path elements) for sleeping state', () => {
    const { container } = render(<Mascot state="sleeping" />);
    const eyeWhites = container.querySelectorAll('[data-eye="white"]');
    expect(eyeWhites.length).toBe(0);
    const closedEyes = container.querySelectorAll('[data-eye="closed"]');
    expect(closedEyes.length).toBe(2);
  });

  it('renders open eyes (ellipses) for non-sleeping states', () => {
    const { container } = render(<Mascot state="idle" />);
    const eyeWhites = container.querySelectorAll('[data-eye="white"]');
    expect(eyeWhites.length).toBe(2);
  });

  it('renders a z-particle container for sleeping state', () => {
    const { container } = render(<Mascot state="sleeping" />);
    const zBox = container.querySelector('[data-mascot="z-container"]');
    expect(zBox).toBeTruthy();
  });

  it('does not render z-particle container for non-sleeping states', () => {
    const { container } = render(<Mascot state="idle" />);
    const zBox = container.querySelector('[data-mascot="z-container"]');
    expect(zBox).toBeFalsy();
  });

  it('renders a ground shadow', () => {
    const { container } = render(<Mascot state="idle" />);
    const shadow = container.querySelector('[data-mascot="shadow"]');
    expect(shadow).toBeTruthy();
  });

  it('applies custom className', () => {
    const { container } = render(<Mascot state="idle" className="w-48 h-48" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('w-48');
    expect(wrapper.className).toContain('h-48');
  });

  it('renders the sleeping mouth ellipse', () => {
    const { container } = render(<Mascot state="sleeping" />);
    const mouth = container.querySelector('[data-mascot="mouth"]');
    expect(mouth).toBeTruthy();
    expect(mouth!.tagName.toLowerCase()).toBe('ellipse');
  });

  it('renders the upright mouth as a path for idle', () => {
    const { container } = render(<Mascot state="idle" />);
    const mouth = container.querySelector('[data-mascot="mouth"]');
    expect(mouth).toBeTruthy();
    expect(mouth!.tagName.toLowerCase()).toBe('path');
  });
});
