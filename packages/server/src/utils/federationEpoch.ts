import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

let cached: string | null = null;

/** This instance's persistent epoch (incarnation UUID). Set by ensureDefaults on boot. */
export function getInstanceId(): string {
  if (cached) return cached;
  const db = getDb();
  const row = db.select({ instanceId: schema.instanceSettings.instanceId })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get();
  if (!row?.instanceId) {
    throw new Error('instance_id is not set — ensureDefaults must run before getInstanceId');
  }
  cached = row.instanceId;
  return cached;
}

/** Test-only: clear the module cache between cases. */
export function __resetInstanceIdCacheForTest(): void {
  cached = null;
}
