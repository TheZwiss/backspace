import fs from 'fs';
import path from 'path';

export type MsnWinkEffect = 'msn_bouncy_ball' | 'msn_bow' | 'msn_dancing_pig' | 'msn_eyeball' | 'msn_frog' | 'msn_guitar_smash' | 'msn_heart' | 'msn_kiss' | 'msn_lipstick_girl' | 'msn_love_letter' | 'msn_notes' | 'msn_silly_face' | 'msn_stars' | 'msn_water_balloon' | 'msn_fart_guy';
interface WinkAsset { file: string; durationMs: number; width: number; height: number; hasAudio: boolean }
const folder = path.join(__dirname, '../resources/nudge-msn');
const catalog: Record<MsnWinkEffect, WinkAsset> = JSON.parse(fs.readFileSync(path.join(folder, 'catalog.json'), 'utf8'));
let lastAsset: { effect: MsnWinkEffect; video: string } | undefined;

export function isMsnWinkEffect(effect: unknown): effect is MsnWinkEffect {
  return typeof effect === 'string' && Object.prototype.hasOwnProperty.call(catalog, effect);
}

export function getMsnWinkAsset(effect: MsnWinkEffect): WinkAsset & { video: string } {
  if (lastAsset?.effect !== effect) {
    lastAsset = { effect, video: 'data:video/webm;base64,' + fs.readFileSync(path.join(folder, catalog[effect].file)).toString('base64') };
  }
  return { ...catalog[effect], video: lastAsset.video };
}
