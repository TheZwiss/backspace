import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initializeInterfaceScale, isMobileViewport, layoutPixels, visualPixels } from './interfaceScale';
import { INTERFACE_SCALES, normalizeInterfaceScale, useInterfaceScaleStore } from '../stores/interfaceScaleStore';
import { computeFloatingPosition, pointAnchor } from '../hooks/useFloatingPosition';
import { InterfaceScaleSection } from '../components/modals/settingsPanels/InterfaceScaleSection';
import { useUIStore } from '../stores/uiStore';

afterEach(() => {
  cleanup();
  useInterfaceScaleStore.getState().setScale(100);
  document.documentElement.style.removeProperty('zoom');
  document.documentElement.style.removeProperty('--interface-scale');
  document.documentElement.style.removeProperty('--titlebar-inset');
  delete window.backspace;
  delete document.documentElement.dataset.viewport;
  vi.restoreAllMocks();
  useUIStore.setState({ isMobile: false, activeModal: null, mobileStack: [] });
});

describe('interface scale', () => {
  it.each([[700, 75, 'desktop'], [1366, 200, 'mobile'], [768, 100, 'desktop']])(
    'shares the JS/CSS breakpoint at width %i and scale %i', (width, scale, expected) => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(Number(width));
      useInterfaceScaleStore.getState().setScale(Number(scale));
      const stop = initializeInterfaceScale();
      expect(document.documentElement.dataset.viewport).toBe(expected);
      expect(isMobileViewport()).toBe(expected === 'mobile');
      stop();
    },
  );
  it('updates the viewport marker on window resize and removes the listener on cleanup', () => {
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900);
    const stop = initializeInterfaceScale();
    width.mockReturnValue(600);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.dataset.viewport).toBe('mobile');
    stop();
    width.mockReturnValue(900);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.dataset.viewport).toBe('mobile');
  });
  it.each(INTERFACE_SCALES)('preserves layout constants passed as visual anchors at %i%%', scale => {
    useInterfaceScaleStore.getState().setScale(scale);
    expect(layoutPixels(visualPixels(100))).toBe(100);
    const position = computeFloatingPosition(pointAnchor(visualPixels(100), visualPixels(100)), 50, 50, 'right', 8);
    expect(position.left).toBe(108);
  });
  it.each(INTERFACE_SCALES)('shares the unscaled native titlebar inset at %i%%', scale => {
    window.backspace = {} as BackspaceElectronAPI;
    useInterfaceScaleStore.getState().setScale(scale);
    const stop = initializeInterfaceScale();
    expect(document.documentElement.style.getPropertyValue('--titlebar-inset')).toBe('calc(33px / var(--interface-scale))');
    expect(document.documentElement.style.getPropertyValue('--interface-scale')).toBe(String(scale / 100));
    stop();
  });
  it('reserves no titlebar inset in the browser', () => {
    const stop = initializeInterfaceScale();
    expect(document.documentElement.style.getPropertyValue('--titlebar-inset')).toBe('0px');
    stop();
  });
  it.each(INTERFACE_SCALES)('persists and restores %i%%', async scale => {
    useInterfaceScaleStore.getState().setScale(scale);
    const persisted = localStorage.getItem('backspace-interface-scale');
    expect(JSON.parse(persisted!).state.scale).toBe(scale);
    useInterfaceScaleStore.getState().setScale(100);
    localStorage.setItem('backspace-interface-scale', persisted!);
    await useInterfaceScaleStore.persist.rehydrate();
    expect(useInterfaceScaleStore.getState().scale).toBe(scale);
  });

  it.each([0, -1, 74, 99, 251, Infinity, NaN, '200', null])('rejects invalid stored value %s', value => {
    expect(normalizeInterfaceScale(value)).toBe(100);
  });

  it('applies persisted scale before rendering, notifies layout hooks, and unsubscribes', () => {
    useInterfaceScaleStore.getState().setScale(175);
    const resize = vi.fn();
    window.addEventListener('resize', resize);
    const stop = initializeInterfaceScale();
    expect(document.documentElement.style.zoom).toBe('1.75');
    useInterfaceScaleStore.getState().setScale(250);
    expect(document.documentElement.style.getPropertyValue('--interface-scale')).toBe('2.5');
    expect(layoutPixels(250)).toBe(100);
    expect(resize).toHaveBeenCalledTimes(2);
    stop();
    useInterfaceScaleStore.getState().setScale(100);
    expect(resize).toHaveBeenCalledTimes(2);
    window.removeEventListener('resize', resize);
  });

  it('fits a zoomed floating surface inside the viewport using layout coordinates', () => {
    useInterfaceScaleStore.getState().setScale(250);
    const pos = computeFloatingPosition(
      { top: 100, left: window.innerWidth - 100, right: window.innerWidth, bottom: 200, width: 100, height: 100 },
      500, 250, 'right', 8,
    );
    expect(pos.actualPlacement).toBe('left');
    expect(pos.left * 2.5 + 500).toBeLessThanOrEqual(window.innerWidth);
    expect(pos.top * 2.5 + 250).toBeLessThanOrEqual(window.innerHeight);
  });

  it('offers all eight scales and resets immediately', () => {
    render(<InterfaceScaleSection />);
    expect(screen.getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(INTERFACE_SCALES.map(String));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '250' } });
    expect(useInterfaceScaleStore.getState().scale).toBe(250);
    fireEvent.click(screen.getByRole('button'));
    expect(useInterfaceScaleStore.getState().scale).toBe(100);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('keeps appearance settings open across the effective mobile breakpoint', () => {
    const resize = () => useUIStore.getState().setIsMobile(layoutPixels(window.innerWidth) < 768);
    window.addEventListener('resize', resize);
    const stop = initializeInterfaceScale();
    useUIStore.setState({ isMobile: false, activeModal: 'userSettings' });
    render(<InterfaceScaleSection />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '250' } });
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('settings-appearance');
    fireEvent.click(screen.getByRole('button'));
    expect(useUIStore.getState().activeModal).toBe('userSettings');
    stop();
    window.removeEventListener('resize', resize);
  });
});
