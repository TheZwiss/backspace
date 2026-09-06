// Render harness: bundles a React entry, loads it in Electron, freezes every
// animation at the requested timestamps and writes one PNG per frame plus a
// contact sheet. Usage (from packages/web):
//   node <harness>/render-frames.mjs --entry ./src/dev/scene-preview.tsx --out ./out \
//        --width 480 --height 320 --scale 2 --times 0,300,900,1500 --moods idle,happy,sad
// The entry module must export `mount(root: HTMLElement, mood: string): void`.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const entry = resolve(args.entry);
const out = resolve(args.out ?? './render-out');
const width = Number(args.width ?? 480);
const height = Number(args.height ?? 320);
const scale = Number(args.scale ?? 2);
const times = String(args.times ?? '0').split(',').map(Number);
const moods = String(args.moods ?? 'idle').split(',');
const bg = args.bg ?? '#13131a';
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [entry], bundle: true, format: 'iife', globalName: 'SceneEntry',
  outfile: join(out, 'bundle.js'), jsx: 'automatic', logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${bg};overflow:hidden}
#root{width:${width}px;height:${height}px}
</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`;
writeFileSync(join(out, 'index.html'), html);

const electronMain = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(process.argv[2]);
const log = (m) => fs.appendFileSync(path.join(cfg.out, 'log.txt'), m + '\\n');
process.on('uncaughtException', (e) => { log('uncaught ' + e.stack); app.exit(3); });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: cfg.width, height: cfg.height, show: false,
    webPreferences: { zoomFactor: cfg.scale, backgroundThrottling: false } });
  await win.loadFile(path.join(cfg.out, 'index.html'));
  win.setContentSize(Math.round(cfg.width * cfg.scale), Math.round(cfg.height * cfg.scale));
  const frames = [];
  for (const mood of cfg.moods) {
    await win.webContents.executeJavaScript(
      'document.getElementById("root").replaceChildren(); SceneEntry.mount(document.getElementById("root"), ' + JSON.stringify(mood) + '); true');
    await new Promise((r) => setTimeout(r, 300));
    for (const t of cfg.times) {
      await win.webContents.executeJavaScript(
        'for (const a of document.getAnimations()) { a.pause(); a.currentTime = ' + t + '; } true');
      await new Promise((r) => setTimeout(r, 120));
      const img = await win.webContents.capturePage();
      const file = path.join(cfg.out, mood + '-' + String(t).padStart(5, '0') + '.png');
      fs.writeFileSync(file, img.toPNG());
      frames.push({ mood, t, file });
    }
  }
  fs.writeFileSync(path.join(cfg.out, 'frames.json'), JSON.stringify(frames));
  log('done ' + frames.length);
  app.exit(0);
});
setTimeout(() => { log('timeout'); app.exit(2); }, 60000);
`;
writeFileSync(join(out, 'electron-main.cjs'), electronMain);
const electronBin = resolve('../desktop/node_modules/.bin/electron');
if (!existsSync(electronBin)) throw new Error('electron not found at ' + electronBin + '; run from packages/web');
execFileSync(electronBin, [join(out, 'electron-main.cjs'), JSON.stringify({ out, width, height, scale, times, moods })], { stdio: 'inherit' });

// Contact sheet: one row per mood, one column per timestamp, via sharp (already a workspace dep).
// Frame dimensions are read from the first PNG: capturePage returns device pixels, so on a
// Retina display a 480px window yields a 960px frame.
const sharp = (await import('sharp')).default;
const frames = JSON.parse(readFileSync(join(out, 'frames.json'), 'utf8'));
const meta = await sharp(frames[0].file).metadata();
const w = meta.width, h = meta.height, gap = 16, label = 28;
const cols = times.length, rows = moods.length;
const composite = [];
for (const [ri, mood] of moods.entries()) for (const [ci, t] of times.entries()) {
  const f = frames.find((x) => x.mood === mood && x.t === t);
  composite.push({ input: f.file, left: gap + ci * (w + gap), top: gap + label + ri * (h + gap + label) });
  const text = Buffer.from(`<svg width="${w}" height="${label}"><text x="4" y="20" font-family="system-ui" font-size="18" fill="#c8c8d4">${mood} @ ${t} ms</text></svg>`);
  composite.push({ input: text, left: gap + ci * (w + gap), top: gap + ri * (h + gap + label) });
}
await sharp({ create: { width: gap + cols * (w + gap), height: gap + rows * (h + gap + label), channels: 4, background: '#0d0d12' } })
  .composite(composite).png().toFile(join(out, 'contact-sheet.png'));
console.log(`contact sheet: ${join(out, 'contact-sheet.png')} (${cols}x${rows} frames of ${w}x${h})`);
