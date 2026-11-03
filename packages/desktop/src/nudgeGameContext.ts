import { desktopCapturer, screen } from 'electron';

interface Geometry {
  window: number[];
  monitor: number[];
  minimized: boolean;
  foreground: boolean;
  exclusive?: boolean;
  process?: string;
}

export function isWallpaperEngineProcess(processName: string): boolean {
  const name = processName.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  return /^(wallpaper(?:32|64)?|wallpaperservice(?:32|64)?|wallpaper_engine|wallpaperengine)$/.test(name);
}

export function hasNudgeGameActivity(activities: { type: string; name: string }[]): boolean {
  return activities.some(activity => activity.type === 'playing'
    && activity.name.toLowerCase().replace(/[\s_-]/g, '') !== 'wallpaperengine');
}

/** Query only when a nudge arrives; no extra polling process runs while idle. */
export async function detectNudgeGames(options: {
  query: (handle: string) => Promise<Geometry | null>;
  isGame: (process: string) => boolean;
  knownGameRunning: boolean;
  physicalBounds: (display: Electron.Display) => Electron.Rectangle;
  platform?: NodeJS.Platform;
}): Promise<{ gameRunning: boolean; foregroundGame: boolean; gameDisplayIds: number[]; gameDetectionUncertain: boolean }> {
  const result = { gameRunning: options.knownGameRunning, foregroundGame: false, gameDisplayIds: [] as number[], gameDetectionUncertain: false };
  if ((options.platform ?? process.platform) !== 'win32') return { ...result, gameDetectionUncertain: true };
  try {
    let enumerationTimer: ReturnType<typeof setTimeout> | undefined;
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }),
      new Promise<null>(resolve => { enumerationTimer = setTimeout(() => resolve(null), 1500); }),
    ]).finally(() => { if (enumerationTimer) clearTimeout(enumerationTimer); });
    if (!sources) return { ...result, gameDetectionUncertain: true };
    const displays = screen.getAllDisplays();
    const handles = sources.map(s => /^window:(\d+):\d+$/.exec(s.id)?.[1]).filter((h): h is string => !!h);
    if (handles.length > 64) result.gameDetectionUncertain = true;
    let cursor = 0;
    let expired = false;
    const seen = new Set<number>();
    const scan = Promise.all(Array.from({ length: Math.min(4, handles.length) }, async () => {
      while (!expired && cursor < Math.min(handles.length, 64)) {
        const geometry = await options.query(handles[cursor++]!);
        if (expired) return;
        if (!geometry) { result.gameDetectionUncertain = true; continue; }
        // Animated wallpaper can use fullscreen rendering without being a game.
        if (geometry.process && isWallpaperEngineProcess(geometry.process)) continue;
        if (geometry.minimized || (!geometry.exclusive && (!geometry.process || !options.isGame(geometry.process)))) continue;
        if (geometry.exclusive && !geometry.foreground && (!geometry.process || !options.isGame(geometry.process))) continue;
        result.gameRunning = true;
        result.foregroundGame ||= geometry.foreground;
        const [x, y, width, height] = geometry.window;
        if (![x, y, width, height].every(Number.isFinite) || width! <= 0 || height! <= 0) { result.gameDetectionUncertain = true; continue; }
        for (const display of displays) {
          const rect = options.physicalBounds(display);
          if (x! < rect.x + rect.width && x! + width! > rect.x && y! < rect.y + rect.height && y! + height! > rect.y) seen.add(display.id);
        }
      }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([scan, new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; result.gameDetectionUncertain = true; resolve(); }, 1800); })]);
    } finally { if (timer) clearTimeout(timer); }
    result.gameDisplayIds = [...seen];
    if (result.gameRunning && !seen.size) result.gameDetectionUncertain = true;
    return result;
  } catch { return { ...result, gameDetectionUncertain: true }; }
}
