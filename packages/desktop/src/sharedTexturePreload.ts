/// <reference lib="dom" />
import { ipcRenderer, sharedTexture } from 'electron';

interface Surface {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
  cursor: OffscreenCanvas;
  invertedCursor: OffscreenCanvas;
  options: { width?: number; height?: number; cursorMode?: string; crop?: { x: number; y: number; width: number; height: number } };
  pending?: { sequence: number; finish: () => void };
}

export function initializeSharedTextureReceiver(): void {
  if (process.platform !== 'win32' || !sharedTexture?.setSharedTextureReceiver) return;
  const surfaces = new Map<string, Surface>();
  ipcRenderer.on('shared-texture-config', (_event, id: string, options: Surface['options'] | null) => {
    if (!options) {
      const surface = surfaces.get(id);
      surface?.pending?.finish();
      if (surface) { surface.canvas.width = 1; surface.cursor.width = 1; surface.invertedCursor.width = 1; }
      surfaces.delete(id);
      return;
    }
    const existing = surfaces.get(id);
    if (existing) { existing.options = options; return; }
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d', { alpha: false });
    if (context) surfaces.set(id, { canvas, context, cursor: new OffscreenCanvas(1, 1), invertedCursor: new OffscreenCanvas(1, 1), options });
  });
  ipcRenderer.on('shared-texture-error', (_event, id: string) => {
    window.postMessage({ type: 'backspace:shared-texture-error', id }, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'backspace:shared-texture-ack') return;
    const pending = surfaces.get(event.data.id)?.pending;
    if (pending && pending.sequence === event.data.sequence) pending.finish();
  });
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
    let frame: VideoFrame | undefined;
    let output: VideoFrame | undefined;
    const surface = surfaces.get(metadata?.id);
    try {
      if (!surface) return;
      const pointer = metadata.cursor;
      const cursor = surface.cursor;
      if (pointer?.pixels && pointer.width > 0 && pointer.height > 0 && pointer.width <= 512 && pointer.height <= 512) {
        const bytes = Uint8ClampedArray.from(atob(pointer.pixels), character => character.charCodeAt(0));
        if (bytes.length === pointer.width * pointer.height * 4) {
          cursor.width = pointer.width; cursor.height = pointer.height;
          cursor.getContext('2d')!.putImageData(new ImageData(bytes, pointer.width, pointer.height), 0, 0);
          const inverse = Uint8ClampedArray.from(atob(pointer.invertPixels ?? ''), character => character.charCodeAt(0));
          const inverted = surface.invertedCursor;
          inverted.width = pointer.width; inverted.height = pointer.height;
          if (inverse.length === bytes.length) inverted.getContext('2d')!.putImageData(new ImageData(inverse, pointer.width, pointer.height), 0, 0);
        }
      }
      if (surface.pending) return;
      frame = importedSharedTexture.getVideoFrame();
      const { canvas, context, options } = surface;
      const region = options.crop ?? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight };
      const height = options.height ?? region.height;
      const width = options.width ?? Math.round(region.width * height / region.height / 2) * 2;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, width, height);
      if (options.cursorMode !== 'hide' && pointer?.visible && cursor.width > 1) {
        context.drawImage(cursor, (pointer.x - region.x) * width / region.width, (pointer.y - region.y) * height / region.height,
          cursor.width * width / region.width, cursor.height * height / region.height);
        context.globalCompositeOperation = 'difference';
        context.drawImage(surface.invertedCursor, (pointer.x - region.x) * width / region.width, (pointer.y - region.y) * height / region.height,
          cursor.width * width / region.width, cursor.height * height / region.height);
        context.globalCompositeOperation = 'source-over';
      }
      // Materialize our own surface; importing directly into WebRTC crashes Electron 43 on clone/readback.
      output = new VideoFrame(canvas, { timestamp: frame.timestamp });
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { finish(); ipcRenderer.send('shared-texture-consumer-stalled', metadata.id); }, 2000);
        const finish = (): void => {
          clearTimeout(timer); surface.pending = undefined; resolve();
        };
        surface.pending = { sequence: metadata.sequence, finish };
        window.postMessage({ type: 'backspace:shared-texture-frame', id: metadata.id,
          sequence: metadata.sequence, poolDrops: metadata.poolDrops, frame: output }, '*', [output!]);
        output = undefined;
      });
    } catch {
      surface?.pending?.finish();
      window.postMessage({ type: 'backspace:shared-texture-error', id: metadata?.id }, '*');
    } finally {
      output?.close(); frame?.close(); importedSharedTexture.release();
    }
  });
}
