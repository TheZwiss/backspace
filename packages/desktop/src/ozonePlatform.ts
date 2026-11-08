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

/**
 * Qual XDG_SESSION_TYPE o processo relançado em XWayland deve enxergar.
 *
 * O capturador de tela do WebRTC escolhe o backend por essa variável, não pelo
 * ozone platform: `x11` captura pelo X server, `wayland` passa pelo portal
 * (xdg-desktop-portal + PipeWire). Rodar em XWayland não muda o que o X server
 * consegue ver: em quase todo compositor ele só desenha clientes X11, então a
 * captura X11 devolve a tela preta e a lista de janelas só tem o próprio app.
 *
 * O KWin (KDE Plasma 6) é a exceção medida: expõe o desktop inteiro a apps X11
 * legados, e lá a captura X11 é imediata e sem diálogo. Nos demais (Hyprland,
 * Sway, GNOME, …) a sessão continua `wayland` para que o portal faça a captura.
 * Sem WAYLAND_DISPLAY a sessão é X11 de verdade e o portal não se aplica.
 */
export function captureSessionType(env: NodeJS.ProcessEnv = process.env): 'x11' | 'wayland' {
  if (!env.WAYLAND_DISPLAY) return 'x11';
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':');
  return desktops.includes('kde') ? 'x11' : 'wayland';
}
