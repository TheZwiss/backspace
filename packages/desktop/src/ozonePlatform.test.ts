import { describe, expect, it } from 'vitest';
import { captureSessionType, shouldForceX11Ozone } from './ozonePlatform';

const socketPresent = () => true;
const socketMissing = () => false;

describe('shouldForceX11Ozone', () => {
  it('nunca força fora do Linux', () => {
    expect(shouldForceX11Ozone('win32', { DISPLAY: ':0' }, socketPresent)).toBe(false);
    expect(shouldForceX11Ozone('darwin', { DISPLAY: ':0' }, socketPresent)).toBe(false);
  });

  it('força quando DISPLAY é válido e o socket X11 existe', () => {
    expect(shouldForceX11Ozone('linux', { DISPLAY: ':0' }, socketPresent)).toBe(true);
    expect(shouldForceX11Ozone('linux', { DISPLAY: ':1.0' }, socketPresent)).toBe(true);
  });

  it('consulta o socket do display informado', () => {
    const seen: string[] = [];
    shouldForceX11Ozone('linux', { DISPLAY: ':12.1' }, (p) => (seen.push(p), true));
    expect(seen).toEqual(['/tmp/.X11-unix/X12']);
  });

  it('não força sem XWayland (socket ausente)', () => {
    expect(shouldForceX11Ozone('linux', { DISPLAY: ':0' }, socketMissing)).toBe(false);
  });

  it('não força com DISPLAY ausente ou inválido', () => {
    expect(shouldForceX11Ozone('linux', {}, socketPresent)).toBe(false);
    expect(shouldForceX11Ozone('linux', { DISPLAY: 'host:0' }, socketPresent)).toBe(false);
    expect(shouldForceX11Ozone('linux', { DISPLAY: '' }, socketPresent)).toBe(false);
  });

  it('não propaga erro ao checar o socket', () => {
    expect(shouldForceX11Ozone('linux', { DISPLAY: ':0' }, () => { throw new Error('eacces'); })).toBe(false);
  });
});

describe('captureSessionType', () => {
  it('usa o portal no KDE Plasma, onde o XWayland só desenha clientes X11 (tela preta com só o cursor)', () => {
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'KDE' })).toBe('wayland');
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'ubuntu:KDE' })).toBe('wayland');
  });

  it('usa o portal nos demais compositores Wayland', () => {
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'Hyprland' })).toBe('wayland');
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'sway' })).toBe('wayland');
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('wayland');
  });

  it('usa X11 numa sessão X11 de verdade, sem WAYLAND_DISPLAY', () => {
    expect(captureSessionType({ XDG_CURRENT_DESKTOP: 'i3' })).toBe('x11');
    expect(captureSessionType({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('x11');
    expect(captureSessionType({})).toBe('x11');
  });

  it('usa o portal quando o desktop é desconhecido', () => {
    expect(captureSessionType({ WAYLAND_DISPLAY: 'wayland-1' })).toBe('wayland');
  });
});
