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
 * Vale para todo compositor, KDE Plasma incluído. Uma versão anterior mantinha
 * `x11` no KDE por achar que o KWin expõe o desktop inteiro a apps X11, mas no
 * Plasma 6.8 isso não vale mais: a captura X11 volta tela preta com só o cursor.
 * Por isso a decisão não depende do desktop: com WAYLAND_DISPLAY a sessão fica
 * `wayland` e o portal faz a captura. Sem WAYLAND_DISPLAY a sessão é X11 de
 * verdade e o portal não se aplica.
 */
export function captureSessionType(env: NodeJS.ProcessEnv = process.env): 'x11' | 'wayland' {
  return env.WAYLAND_DISPLAY ? 'wayland' : 'x11';
}
