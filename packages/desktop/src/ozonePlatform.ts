import { existsSync } from 'fs';

/**
 * Decide o backend do Electron (ozone platform) no Linux.
 *
 * No KDE Plasma Wayland (e outros compositores Wayland), o compositor ignora
 * setPosition()/setBounds() do Electron - a janela cai no centro da tela.
 * O Electron reporta a posição pedida mas o compositor não obedece.
 *
 * Forçar --ozone-platform=x11 roda via XWayland, onde o X server obedece
 * as coordenadas. O desktopCapturer.getSources() também fica rápido e completo.
 *
 * Fallback para Wayland puro apenas quando não há XWayland (DISPLAY não aponta
 * para um socket X11 válido em /tmp/.X11-unix/).
 */
export function shouldForceX11Ozone(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (socketPath: string) => boolean = existsSync,
): boolean {
  if (platform !== 'linux') return false;
  const display = env.DISPLAY || '';
  // DISPLAY válido tem formato :N ou :N.M
  const m = /^:(\d+)(\.\d+)?$/.exec(display);
  if (!m) return false;
  // Verificar se o socket Unix do X server existe
  try {
    return socketExists(`/tmp/.X11-unix/X${m[1]}`);
  } catch {
    return false;
  }
}
