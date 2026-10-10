import { nativeImage } from 'electron';
import path from 'path';

// ─── Tray Icon ──────────────────────────────────────────────────────────────

function generateFallbackTrayIcon(): Electron.NativeImage {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        // NativeImage raw buffer uses BGRA on most platforms
        canvas[idx] = 0xf6;     // B (#7c6cf6)
        canvas[idx + 1] = 0x6c; // G
        canvas[idx + 2] = 0x7c; // R
        canvas[idx + 3] = 0xff; // A
      } else {
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

export function loadTrayIcon(): Electron.NativeImage {
  const resourcesDir = path.join(__dirname, '..', 'resources');
  try {
    if (process.platform === 'darwin') {
      // macOS template image: Electron auto-resolves @2x from the base path.
      // Template images adapt to light/dark menu bar automatically.
      const templatePath = path.join(resourcesDir, 'tray-iconTemplate.png');
      const icon = nativeImage.createFromPath(templatePath);
      if (!icon.isEmpty()) {
        icon.setTemplateImage(true);
        return icon;
      }
    } else if (process.platform === 'win32') {
      // Windows: multi-size .ico — Windows + Electron auto-pick best size for current DPI.
      const icoPath = path.join(resourcesDir, 'tray-icon.ico');
      const icon = nativeImage.createFromPath(icoPath);
      if (!icon.isEmpty()) {
        return icon;
      }
    } else {
      // Linux: single 22x22 PNG (AppIndicator / StatusNotifier convention).
      // No runtime resize — the source is already at correct tray size.
      const iconPath = path.join(resourcesDir, 'tray-icon.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        return icon;
      }
    }
  } catch {
    // Fall through to generated icon
  }
  return generateFallbackTrayIcon();
}
