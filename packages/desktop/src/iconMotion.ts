import fs from 'fs';
import path from 'path';

let cachedScript: string | undefined;
export function getIconMotionScript(): string {
  if (cachedScript) return cachedScript;
  const resources = path.join(__dirname, '../resources');
  const source = fs.readFileSync(path.join(resources, 'icon-motion.js'), 'utf8').replace(/^\uFEFF/, '').replace('export function installIconMotion', 'function installIconMotion');
  const definitions = JSON.parse(fs.readFileSync(path.join(resources, 'icon-motion.json'), 'utf8').replace(/^\uFEFF/, ''));
  cachedScript = `(()=>{${source};installIconMotion(document,${JSON.stringify(definitions)})})()`;
  return cachedScript;
}
