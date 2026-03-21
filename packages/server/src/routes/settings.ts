import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { config } from '../config.js';
import type { InstanceStreamingLimits, InstanceAdminSettings } from '@backspace/shared';
import { STANDARD_RESOLUTIONS, STANDARD_FRAMERATES } from '@backspace/shared/src/constants.js';

function rowToLimits(row: typeof schema.instanceSettings.$inferSelect): InstanceStreamingLimits {
  return {
    maxBitrateKbps: row.maxBitrateKbps,
    minBitrateKbps: row.minBitrateKbps,
    bitrateStepKbps: row.bitrateStepKbps,
    allowedResolutions: row.allowedResolutions.split(',')
      .map((s) => s.trim())
      .map((s) => s === 'native' ? 'native' as const : Number(s))
      .filter((v): v is number | 'native' =>
        v === 'native' || (typeof v === 'number' && !isNaN(v) && (STANDARD_RESOLUTIONS as readonly number[]).includes(v))
      ),
    allowedFramerates: row.allowedFramerates.split(',')
      .map(Number)
      .filter((n) => (STANDARD_FRAMERATES as readonly number[]).includes(n)),
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
  app.patch<{ Body: Partial<InstanceStreamingLimits> }>('/api/settings/streaming', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const db = getDb();

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
      const invalid = body.allowedResolutions.filter((r) =>
        r !== 'native' && !(STANDARD_RESOLUTIONS as readonly number[]).includes(r as number)
      );
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Invalid resolutions: ${invalid.join(', ')}. Allowed: ${[...STANDARD_RESOLUTIONS, 'native'].join(', ')}`, statusCode: 400 });
      }
      // Serialize: numbers sorted ascending, 'native' always last
      const nums = body.allowedResolutions.filter((r): r is number => r !== 'native').sort((a, b) => a - b);
      const hasNative = body.allowedResolutions.includes('native');
      updateData.allowedResolutions = [...nums, ...(hasNative ? ['native'] : [])].join(',');
    }

    if (body.allowedFramerates !== undefined) {
      if (!Array.isArray(body.allowedFramerates) || body.allowedFramerates.length === 0) {
        return reply.code(400).send({ error: 'allowedFramerates must be a non-empty array', statusCode: 400 });
      }
      const invalid = body.allowedFramerates.filter((f) => !(STANDARD_FRAMERATES as readonly number[]).includes(f));
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Invalid framerates: ${invalid.join(', ')}. Allowed: ${STANDARD_FRAMERATES.join(', ')}`, statusCode: 400 });
      }
      updateData.allowedFramerates = body.allowedFramerates.sort((a, b) => a - b).join(',');
    }

    if (body.maxResolution !== undefined) {
      if (!(STANDARD_RESOLUTIONS as readonly number[]).includes(body.maxResolution)) {
        return reply.code(400).send({ error: `maxResolution must be one of: ${STANDARD_RESOLUTIONS.join(', ')}`, statusCode: 400 });
      }
      updateData.maxResolution = body.maxResolution;
    }

    if (body.maxFramerate !== undefined) {
      if (!(STANDARD_FRAMERATES as readonly number[]).includes(body.maxFramerate)) {
        return reply.code(400).send({ error: `maxFramerate must be one of: ${STANDARD_FRAMERATES.join(', ')}`, statusCode: 400 });
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

  // GET /api/settings/instance — admin only, returns instance admin settings
  app.get('/api/settings/instance', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    const db = getDb();

    const row = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!row) {
      return reply.code(500).send({ error: 'Instance settings not initialized', statusCode: 500 });
    }

    const gifKey = row.gifApiKey as string | null;
    const response: InstanceAdminSettings = {
      instanceName: row.instanceName ?? 'Backspace',
      registrationOpen: row.registrationOpen !== null ? row.registrationOpen === 1 : config.registrationOpen,
      discoveryEnabled: row.discoveryEnabled === 1,
      gifApiKey: gifKey ? `****${gifKey.slice(-4)}` : undefined,
      gifEnabled: !!gifKey,
    };

    return reply.code(200).send(response);
  });

  // PATCH /api/settings/instance — admin only, updates instance admin settings
  app.patch<{ Body: Partial<InstanceAdminSettings> }>('/api/settings/instance', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const db = getDb();

    const body = request.body;
    const updateData: Record<string, number | string | null> = { updatedAt: Date.now() };

    if (body.instanceName !== undefined) {
      if (typeof body.instanceName !== 'string' || body.instanceName.trim().length === 0 || body.instanceName.trim().length > 32) {
        return reply.code(400).send({ error: 'Instance name must be 1-32 characters', statusCode: 400 });
      }
      updateData.instanceName = body.instanceName.trim();
    }

    if (body.registrationOpen !== undefined) {
      updateData.registrationOpen = body.registrationOpen ? 1 : 0;
    }

    if (body.discoveryEnabled !== undefined) {
      updateData.discoveryEnabled = body.discoveryEnabled ? 1 : 0;
    }

    if (body.gifApiKey !== undefined) {
      // Skip masked placeholder values — the GET endpoint returns '****xxxx' for security,
      // so if the client sends that back unchanged, don't corrupt the real key
      if (typeof body.gifApiKey === 'string' && body.gifApiKey.startsWith('****')) {
        // Masked value — ignore, keep existing key
      } else {
        // Allow empty string to clear the key
        updateData.gifApiKey = body.gifApiKey ? body.gifApiKey.trim() : null;
      }
    }

    db.update(schema.instanceSettings).set(updateData).where(eq(schema.instanceSettings.id, 1)).run();

    const updatedRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!updatedRow) {
      return reply.code(500).send({ error: 'Failed to read updated settings', statusCode: 500 });
    }

    const updatedGifKey = updatedRow.gifApiKey as string | null;
    const response: InstanceAdminSettings = {
      instanceName: updatedRow.instanceName ?? 'Backspace',
      registrationOpen: updatedRow.registrationOpen !== null ? updatedRow.registrationOpen === 1 : config.registrationOpen,
      discoveryEnabled: updatedRow.discoveryEnabled === 1,
      gifApiKey: updatedGifKey ? `****${updatedGifKey.slice(-4)}` : undefined,
      gifEnabled: !!updatedGifKey,
    };

    return reply.code(200).send(response);
  });
}
