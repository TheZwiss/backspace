import { mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

/** Install an application entry only on an explicit user request. */
export function integrateAppImage(image: string | undefined, dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share')): boolean {
  if (!image || !isAbsolute(image) || /[\r\n\0]/.test(image)) return false;
  const dir = join(dataHome, 'applications');
  const file = join(dir, 'io.github.TheZwiss.backspace.desktop');
  const executable = image.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Backspace\nExec="${executable}"\nTerminal=false\nCategories=Network;Chat;\n`, { flag: 'wx', mode: 0o644 });
    return true;
  } catch (error) {
    // An existing entry belongs to the user or an installer; never overwrite it.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true;
    console.warn('[AppImage] Desktop integration failed:', error);
    return false;
  }
}
