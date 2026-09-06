import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { utcDay } from '../telemetry/day.js';
import { readTelemetryState, setTelemetryEnabled } from '../telemetry/state.js';
import { buildTelemetryPayload, payloadContextFromConfig } from '../telemetry/payload.js';
import type { TelemetryStatus, TelemetryPayload } from '@backspace/shared';

/**
 * The opt-in usage report ("Say hi to Jannis"). Its own file so the id
 * lifecycle has exactly one owner: the general settings PATCH never touches
 * these columns, and every transition goes through setTelemetryEnabled.
 *
 * See docs/systems/telemetry.md.
 */
export async function adminTelemetryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/telemetry: the current opt-in state, including the id so
  // the settings panel can show it masked and the admin can quote it if a ping
  // ever needs tracing.
  app.get(
    '/api/admin/telemetry',
    { preHandler: [authenticate, requireAdmin] },
    async (): Promise<TelemetryStatus> => readTelemetryState(getRawDb()),
  );

  // PUT /api/admin/telemetry: the on/off transition. Enabling an instance
  // that is already on is a no-op in setTelemetryEnabled: a repeated save must
  // not rotate the id or restamp the last reported day.
  app.put<{ Body: { enabled?: unknown } | undefined }>(
    '/api/admin/telemetry',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply): Promise<TelemetryStatus | undefined> => {
      const enabled = request.body?.enabled;
      if (typeof enabled !== 'boolean') {
        sendError(reply, 400, 'validation_failed');
        return undefined;
      }
      return setTelemetryEnabled(getRawDb(), enabled, utcDay(new Date()));
    },
  );

  // GET /api/admin/telemetry/preview: the exact document a ping would carry
  // right now, built by the same function the reporter uses so the modal and
  // the settings panel can never show something the reporter would not send.
  //
  // While reporting is off there is no id, and minting one here would opt the
  // instance in by opening a preview. The literal "preview" stands in instead;
  // nothing is written either way.
  app.get(
    '/api/admin/telemetry/preview',
    { preHandler: [authenticate, requireAdmin] },
    async (): Promise<TelemetryPayload> => {
      const sqlite = getRawDb();
      const state = readTelemetryState(sqlite);
      const today = utcDay(new Date());
      return buildTelemetryPayload(sqlite, payloadContextFromConfig(config, today, state.id ?? 'preview'));
    },
  );
}
