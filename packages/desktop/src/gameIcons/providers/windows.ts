import path from 'path';
import { extractPeIcon } from '../../peIcon';
import { MAX_ICON_BYTES, isFile, safeReaddir } from '../files';
import type { GameIcon, GameIconTarget } from '../types';

async function extractExeIcon(file: string): Promise<GameIcon | null> {
  const bytes = await extractPeIcon(file, MAX_ICON_BYTES);
  return bytes ? { bytes, mime: 'image/png' } : null;
}

export async function windowsProgramIcon(target: GameIconTarget): Promise<GameIcon | null> {
  if (target.exe && /\.exe$/i.test(target.exe) && isFile(target.exe)) {
    const native = await extractExeIcon(target.exe);
    if (native) return native;
  }
  if (!target.cwd || !target.winExes) return null;
  let entries: string[] | null = null;
  for (const name of target.winExes) {
    if (!/\.exe$/i.test(name) || name.includes('/') || name.includes('\\')) continue;
    let file: string | null = path.join(target.cwd, name);
    if (!isFile(file)) {
      entries ??= safeReaddir(target.cwd);
      const found = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
      file = found ? path.join(target.cwd, found) : null;
    }
    if (!file) continue;
    const icon = await extractExeIcon(file);
    if (icon) return icon;
  }
  return null;
}
