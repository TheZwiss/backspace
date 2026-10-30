import fs from 'fs';
import path from 'path';
import { firstExistingIcon } from '../files';
import type { GameIcon, GameIconTarget } from '../types';

function appBundle(exe: string): string | null {
  let current = path.dirname(exe);
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return null;
}

function resourcePngs(bundle: string): string[] {
  const resources = path.join(bundle, 'Contents', 'Resources');
  let names: string[];
  try {
    names = fs.readdirSync(resources);
  } catch {
    return [];
  }
  const pngs = names
    .filter((name) => /\.png$/i.test(name))
    .map((name) => path.join(resources, name))
    .sort((a, b) => {
      const score = (file: string) => /(?:app|icon)/i.test(path.basename(file)) ? 0 : 1;
      return score(a) - score(b);
    });
  return pngs;
}

export async function macApplicationIcon(target: GameIconTarget): Promise<GameIcon | null> {
  if (process.platform !== 'darwin' || !target.exe) return null;
  const bundle = appBundle(target.exe);
  return bundle ? firstExistingIcon(resourcePngs(bundle)) : null;
}
