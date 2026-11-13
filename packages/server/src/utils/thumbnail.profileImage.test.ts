import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resizeProfileImage } from './thumbnail';
import { cropAnimatedBanner } from './cropAnimatedBanner';

// Two-frame 300x200 GIF (150x100 per frame). Embedded so the test does not
// depend on an external image tool.
const ANIMATED_GIF_BASE64 =
  'R0lGODlhLAFkAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAALAFkAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDixcfT768+fPo06tfz769+/fw48ufT99tQAAh+QQBCgABACwAAAAALAFkAIEAAP8AAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDixcfT768+fPo06tfz769+/fw48ufT99tQAA7';

// The test reads the file back with sharp; without this Windows keeps it open
// and the temp dir cannot be removed.
sharp.cache(false);

let dir: string;
let filepath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-profile-'));
  filepath = path.join(dir, 'avatar.gif');
  fs.writeFileSync(filepath, Buffer.from(ANIMATED_GIF_BASE64, 'base64'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resizeProfileImage', () => {
  it('downscales an animated GIF without losing its frames or format', async () => {
    const before = await sharp(filepath, { animated: true }).metadata();
    expect(before.pages).toBe(2);

    await resizeProfileImage(filepath, 'avatar');

    const after = await sharp(filepath, { animated: true }).metadata();
    expect(after.format).toBe('gif');
    expect(after.width).toBe(256);
    expect(after.pages).toBe(2);
  });

  it('leaves a GIF that already fits untouched', async () => {
    const small = path.join(dir, 'small.gif');
    await sharp(filepath, { animated: true }).resize({ width: 200 }).gif().toFile(small);

    await resizeProfileImage(small, 'avatar');

    const after = await sharp(small, { animated: true }).metadata();
    expect(after.width).toBe(200);
    expect(after.pages).toBe(2);
  });
});

describe('animated banner cropping', () => {
  it('preserves every frame, its timing, and the original upload', async () => {
    const original = fs.readFileSync(filepath);
    const before = await sharp(filepath, { animated: true }).metadata();
    const output = path.join(dir, 'cropped.gif');
    await cropAnimatedBanner(filepath, output, { x: 40, y: 8, width: 160, height: 90 });
    const after = await sharp(output, { animated: true }).metadata();
    expect(after.format).toBe('gif');
    expect(after.pages).toBe(before.pages);
    expect(after.delay).toEqual(before.delay);
    expect(after.loop).toBe(before.loop);
    expect(after.width).toBe(160);
    expect(after.pageHeight).toBe(90);
    expect(fs.readFileSync(filepath).equals(original)).toBe(true);
  });
  it('refuses invalid coordinates without changing the source', async () => {
    const output = path.join(dir, 'invalid.gif');
    await expect(cropAnimatedBanner(filepath, output, { x: -1, y: 0, width: 10, height: 10 })).rejects.toThrow();
    await expect(cropAnimatedBanner(filepath, output, { x: 250, y: 0, width: 100, height: 100 })).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  });
});
