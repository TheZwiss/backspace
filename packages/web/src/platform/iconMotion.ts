import { installIconMotion } from '../../../desktop/resources/icon-motion.js';
import definitions from '../../../desktop/resources/icon-motion.json';
export type IconMotionFamily = keyof typeof definitions;
export function installIconClickMotion(targetDocument: Document = document): () => void {
  return installIconMotion(targetDocument, definitions);
}
