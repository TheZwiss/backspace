import fs from 'fs';
import path from 'path';
export const nudgeVisualTheme = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/ui-theme.json'), 'utf8').replace(/^\uFEFF/, '')) as {
  surface: string; foreground: string; muted: string; accent: string; border: string; radius: number; fontFamily: string;
};
let cachedFont: string | undefined;
export function getNudgeFont(): string {
  cachedFont ??= fs.readFileSync(path.join(__dirname, '../resources/fonts/DMSans-Variable.woff2')).toString('base64');
  return cachedFont;
}
