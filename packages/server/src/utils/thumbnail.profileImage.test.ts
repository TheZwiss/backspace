import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resizeProfileImage } from './thumbnail';

// Two-frame 300x200 GIF (150x100 per frame). Embedded so the test does not
// depend on an external image tool.
const ANIMATED_GIF_BASE64 =
  'R0lGODlhLAFkAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAALAFkAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDixcfT768+fPo06tfz769+/fw48ufT99tQAAh+QQBCgABACwAAAAALAFkAIEAAP8AAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDih1LtqzZs2jTql3Ltq3bt3Djyp1Lt67du3jz6t3Lt6/fv4ADCx5MuLDhw4gTK17MuLHjx5AjS55MubLly5gza97MubPnz6BDix5NurTp06hTq17NurXr17Bjy55Nu7bt27hz697Nu7fv38CDCx9OvLjx48iTK1/OvLnz59CjS59Ovbr169iza9/Ovbv37+DDixcfT768+fPo06tfz769+/fw48ufT99tQAA7';

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
