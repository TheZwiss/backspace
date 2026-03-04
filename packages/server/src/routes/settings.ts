import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import type { InstanceStreamingLimits } from '@backspace/shared';

const VALID_RESOLUTIONS = [540, 720, 1080];
const VALID_FRAMERATES = [30, 45, 60];

function rowToLimits(row: typeof schema.instanceSettings.$inferSelect): InstanceStreamingLimits {
  return {
    maxBitrateKbps: row.maxBitrateKbps,
    minBitrateKbps: row.minBitrateKbps,
    bitrateStepKbps: row.bitrateStepKbps,
    allowedResolutions: row.allowedResolutions.split(',').map(Number).filter((n) => VALID_RESOLUTIONS.includes(n)),
    allowedFramerates: row.allowedFramerates.split(',').map(Number).filter((n) => VALID_FRAMERATES.includes(n)),
    maxResolution: row.maxResolution,
    maxFramerate: row.maxFramerate,
    discoveryEnabled: row.discoveryEnabled === 1,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/settings/streaming — any authenticated user can read instance limits
  app.get('/api/settings/streaming', { preHandler: authenticate }, async (_request, reply) => {
    const db = getDb();
    const row = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!row) {
      return reply.code(500).send({ error: 'Instance settings not initialized', statusCode: 500 });
    }
    return reply.code(200).send(rowToLimits(row));
  });

  // PATCH /api/settings/streaming — admin only
  app.patch<{ Body: Partial<InstanceStreamingLimits> }>('/api/settings/streaming', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();

    // Verify caller is an instance admin
    const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller || caller.isAdmin !== 1) {
      return reply.code(403).send({ error: 'Only instance admins can modify streaming settings', statusCode: 403 });
    }

    const body = request.body;
    const updateData: Record<string, number | string> = { updatedAt: Date.now() };

    if (body.maxBitrateKbps !== undefined) {
      if (typeof body.maxBitrateKbps !== 'number' || body.maxBitrateKbps < 500 || body.maxBitrateKbps > 50000) {
        return reply.code(400).send({ error: 'maxBitrateKbps must be between 500 and 50000', statusCode: 400 });
      }
      updateData.maxBitrateKbps = body.maxBitrateKbps;
    }

    if (body.minBitrateKbps !== undefined) {
      if (typeof body.minBitrateKbps !== 'number' || body.minBitrateKbps < 100 || body.minBitrateKbps > 50000) {
        return reply.code(400).send({ error: 'minBitrateKbps must be between 100 and 50000', statusCode: 400 });
      }
      updateData.minBitrateKbps = body.minBitrateKbps;
    }

    if (body.bitrateStepKbps !== undefined) {
      if (typeof body.bitrateStepKbps !== 'number' || body.bitrateStepKbps < 50 || body.bitrateStepKbps > 5000) {
        return reply.code(400).send({ error: 'bitrateStepKbps must be between 50 and 5000', statusCode: 400 });
      }
      updateData.bitrateStepKbps = body.bitrateStepKbps;
    }

    if (body.allowedResolutions !== undefined) {
      if (!Array.isArray(body.allowedResolutions) || body.allowedResolutions.length === 0) {
        return reply.code(400).send({ error: 'allowedResolutions must be a non-empty array', statusCode: 400 });
      }
      const invalid = body.allowedResolutions.filter((r) => !VALID_RESOLUTIONS.includes(r));
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Invalid resolutions: ${invalid.join(', ')}. Allowed: ${VALID_RESOLUTIONS.join(', ')}`, statusCode: 400 });
      }
      updateData.allowedResolutions = body.allowedResolutions.sort((a, b) => a - b).join(',');
    }

    if (body.allowedFramerates !== undefined) {
      if (!Array.isArray(body.allowedFramerates) || body.allowedFramerates.length === 0) {
        return reply.code(400).send({ error: 'allowedFramerates must be a non-empty array', statusCode: 400 });
      }
      const invalid = body.allowedFramerates.filter((f) => !VALID_FRAMERATES.includes(f));
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Invalid framerates: ${invalid.join(', ')}. Allowed: ${VALID_FRAMERATES.join(', ')}`, statusCode: 400 });
      }
      updateData.allowedFramerates = body.allowedFramerates.sort((a, b) => a - b).join(',');
    }

    if (body.maxResolution !== undefined) {
      if (!VALID_RESOLUTIONS.includes(body.maxResolution)) {
        return reply.code(400).send({ error: `maxResolution must be one of: ${VALID_RESOLUTIONS.join(', ')}`, statusCode: 400 });
      }
      updateData.maxResolution = body.maxResolution;
    }

    if (body.maxFramerate !== undefined) {
      if (!VALID_FRAMERATES.includes(body.maxFramerate)) {
        return reply.code(400).send({ error: `maxFramerate must be one of: ${VALID_FRAMERATES.join(', ')}`, statusCode: 400 });
      }
      updateData.maxFramerate = body.maxFramerate;
    }

    if (body.discoveryEnabled !== undefined) {
      updateData.discoveryEnabled = body.discoveryEnabled ? 1 : 0;
    }

    // Cross-field validation: min < max
    const currentRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!currentRow) {
      return reply.code(500).send({ error: 'Instance settings not initialized', statusCode: 500 });
    }

    const effectiveMin = (updateData.minBitrateKbps as number | undefined) ?? currentRow.minBitrateKbps;
    const effectiveMax = (updateData.maxBitrateKbps as number | undefined) ?? currentRow.maxBitrateKbps;
    if (effectiveMin >= effectiveMax) {
      return reply.code(400).send({ error: 'minBitrateKbps must be less than maxBitrateKbps', statusCode: 400 });
    }

    db.update(schema.instanceSettings).set(updateData).where(eq(schema.instanceSettings.id, 1)).run();

    const updatedRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!updatedRow) {
      return reply.code(500).send({ error: 'Failed to read updated settings', statusCode: 500 });
    }

    return reply.code(200).send(rowToLimits(updatedRow));
  });
}
