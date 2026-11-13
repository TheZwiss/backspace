import { and, eq, like } from 'drizzle-orm';
import { parseDmSystemEvent } from '@backspace/shared/src/dmSystemEvents.js';
import { getDb, schema } from '../db/index.js';

/** A restart cannot reconstruct the moment a call was lost. Mark it interrupted
 * instead of leaving a permanent running counter or inventing an end time. */
export function recoverInterruptedDmCalls(): void {
  const db = getDb();
  const rows = db.select({ id: schema.dmMessages.id, content: schema.dmMessages.content })
    .from(schema.dmMessages)
    .where(and(eq(schema.dmMessages.type, 'system'), like(schema.dmMessages.content, '{"event":"call_history",%'))).all();
  db.transaction((tx) => {
    for (const row of rows) {
      const event = parseDmSystemEvent(row.content);
      if (event?.event !== 'call_history' || !['ringing', 'active'].includes(event.status)) continue;
      tx.update(schema.dmMessages).set({ content: JSON.stringify({ ...event, status: 'interrupted', endedAt: null }) }).where(eq(schema.dmMessages.id, row.id)).run();
    }
  });
}
