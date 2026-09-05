// Entry for packages/web/scripts/render-frames.mjs. Nothing in the app imports
// this file; the harness bundles it on its own and calls mount().
import { createRoot, type Root } from 'react-dom/client';
import { HelloScene, type SceneMood } from '../components/telemetry/scene/HelloScene';

const MOODS: readonly SceneMood[] = ['idle', 'happy', 'farewell'];

let current: Root | null = null;

export function mount(root: HTMLElement, mood: string): void {
  current?.unmount();
  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  root.appendChild(host);
  const chosen = MOODS.find((candidate) => candidate === mood) ?? 'idle';
  current = createRoot(host);
  current.render(<HelloScene mood={chosen} />);
}
