import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { config } from '../config.js';
import type { InstanceStreamingLimits, InstanceAdminSettings } from '@backspace/shared';
import { STANDARD_RESOLUTIONS, STANDARD_FRAMERATES, BITRATE_MATRIX_KBPS } from '@backspace/shared/src/constants.js';

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
    bitrateMatrixOverrides: (() => {
      const raw = row.bitrateMatrixOverrides as string | null;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return Object.keys(parsed).length > 0 ? parsed as Record<string, number> : null;
      } catch { return null; }
    })(),
    allowCustomBitrate: row.allowCustomBitrate === 1,
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
    const updateData: Record<string, number | string | null> = { updatedAt: Date.now() };

    if (body.maxBitrateKbps !== undefined) {
      if (typeof body.maxBitrateKbps !== 'number' || body.maxBitrateKbps < 500 || body.maxBitrateKbps > 1000000) {
        return reply.code(400).send({ error: 'maxBitrateKbps must be between 500 and 1000000', statusCode: 400 });
      }
      updateData.maxBitrateKbps = body.maxBitrateKbps;
    }

    if (body.minBitrateKbps !== undefined) {
      if (typeof body.minBitrateKbps !== 'number' || body.minBitrateKbps < 100 || body.minBitrateKbps > 1000000) {
        return reply.code(400).send({ error: 'minBitrateKbps must be between 100 and 1000000', statusCode: 400 });
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

    if (body.allowCustomBitrate !== undefined) {
      updateData.allowCustomBitrate = body.allowCustomBitrate ? 1 : 0;
    }

    if (body.bitrateMatrixOverrides !== undefined) {
      if (body.bitrateMatrixOverrides === null) {
        updateData.bitrateMatrixOverrides = null;
      } else if (typeof body.bitrateMatrixOverrides !== 'object' || Array.isArray(body.bitrateMatrixOverrides)) {
        return reply.code(400).send({ error: 'bitrateMatrixOverrides must be an object or null', statusCode: 400 });
      } else {
        // Validate each key and value
        const validKeys = new Set<string>();
        for (const res of STANDARD_RESOLUTIONS) {
          for (const fps of STANDARD_FRAMERATES) {
            validKeys.add(`${res}_${fps}`);
          }
        }
        for (const [key, value] of Object.entries(body.bitrateMatrixOverrides)) {
          if (!validKeys.has(key)) {
            return reply.code(400).send({ error: `Invalid matrix key: "${key}". Keys must be {resolution}_{framerate}, e.g. "1080_60"`, statusCode: 400 });
          }
          if (typeof value !== 'number' || value <= 0 || value > 1000000) {
            return reply.code(400).send({ error: `Invalid value for "${key}": must be a positive number up to 1000000 kbps`, statusCode: 400 });
          }
        }
        updateData.bitrateMatrixOverrides = JSON.stringify(body.bitrateMatrixOverrides);
      }
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
    const maxUploadBytes = row.maxUploadSizeBytes ?? config.maxUploadSize;
    const response: InstanceAdminSettings = {
      instanceName: row.instanceName ?? 'Backspace',
      registrationOpen: row.registrationOpen !== null ? row.registrationOpen === 1 : config.registrationOpen,
      federatedRegistrationOpen: row.federatedRegistrationOpen === 1,
      discoveryEnabled: row.discoveryEnabled === 1,
      gifApiKey: gifKey ? `****${gifKey.slice(-4)}` : undefined,
      gifEnabled: !!gifKey,
      maxUploadSizeMb: Math.round(maxUploadBytes / (1024 * 1024)),
      federationRelayEnabled: row.federationRelayEnabled === 1,
      federationRelayTtlDays: row.federationRelayTtlDays,
      defaultAutoRotateIntervalDays: row.defaultAutoRotateIntervalDays,
      autoAcceptPeering: row.autoAcceptPeering === 1,
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

    if (body.federatedRegistrationOpen !== undefined) {
      if (typeof body.federatedRegistrationOpen !== 'boolean') {
        return reply.code(400).send({ error: 'federatedRegistrationOpen must be boolean', statusCode: 400 });
      }
      updateData.federatedRegistrationOpen = body.federatedRegistrationOpen ? 1 : 0;
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

    if (body.maxUploadSizeMb !== undefined) {
      const mb = Number(body.maxUploadSizeMb);
      const MAX_MB = Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024));
      if (!Number.isFinite(mb) || !Number.isInteger(mb) || mb < 1 || mb > MAX_MB) {
        return reply.code(400).send({ error: `maxUploadSizeMb must be a positive integer (1 - ${MAX_MB})`, statusCode: 400 });
      }
      updateData.maxUploadSizeBytes = mb * 1024 * 1024;
    }

    if (body.federationRelayEnabled !== undefined) {
      updateData.federationRelayEnabled = body.federationRelayEnabled ? 1 : 0;
    }

    if (body.federationRelayTtlDays !== undefined) {
      const ttl = Number(body.federationRelayTtlDays);
      if (isNaN(ttl) || !Number.isInteger(ttl) || ttl < 1 || ttl > 365) {
        return reply.code(400).send({ error: 'federationRelayTtlDays must be an integer between 1 and 365', statusCode: 400 });
      }
      updateData.federationRelayTtlDays = ttl;
    }

    if (body.defaultAutoRotateIntervalDays !== undefined) {
      const interval = Number(body.defaultAutoRotateIntervalDays);
      if (isNaN(interval) || !Number.isInteger(interval) || interval < 1 || interval > 365) {
        return reply.code(400).send({ error: 'defaultAutoRotateIntervalDays must be an integer between 1 and 365', statusCode: 400 });
      }
      updateData.defaultAutoRotateIntervalDays = interval;
    }

    if (body.autoAcceptPeering !== undefined) {
      updateData.autoAcceptPeering = body.autoAcceptPeering ? 1 : 0;
    }

    db.update(schema.instanceSettings).set(updateData).where(eq(schema.instanceSettings.id, 1)).run();

    const updatedRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!updatedRow) {
      return reply.code(500).send({ error: 'Failed to read updated settings', statusCode: 500 });
    }

    const updatedGifKey = updatedRow.gifApiKey as string | null;
    const updatedMaxUploadBytes = updatedRow.maxUploadSizeBytes ?? config.maxUploadSize;
    const response: InstanceAdminSettings = {
      instanceName: updatedRow.instanceName ?? 'Backspace',
      registrationOpen: updatedRow.registrationOpen !== null ? updatedRow.registrationOpen === 1 : config.registrationOpen,
      federatedRegistrationOpen: updatedRow.federatedRegistrationOpen === 1,
      discoveryEnabled: updatedRow.discoveryEnabled === 1,
      gifApiKey: updatedGifKey ? `****${updatedGifKey.slice(-4)}` : undefined,
      gifEnabled: !!updatedGifKey,
      maxUploadSizeMb: Math.round(updatedMaxUploadBytes / (1024 * 1024)),
      federationRelayEnabled: updatedRow.federationRelayEnabled === 1,
      federationRelayTtlDays: updatedRow.federationRelayTtlDays,
      defaultAutoRotateIntervalDays: updatedRow.defaultAutoRotateIntervalDays,
      autoAcceptPeering: updatedRow.autoAcceptPeering === 1,
    };

    return reply.code(200).send(response);
  });
}
