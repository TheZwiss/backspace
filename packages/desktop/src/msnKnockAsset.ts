import fs from 'fs';
import path from 'path';

let cached: string | undefined;
export function getMsnKnockVideo(): string {
  cached ??= 'data:video/webm;base64,' + fs.readFileSync(path.join(__dirname, '../resources/nudge-msn/knock.webm')).toString('base64');
  return cached;
}
