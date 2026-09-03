import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { config } from '../config.js';
import { getLatestRelease, deriveState } from '../utils/releaseCheck.js';
import type { InstanceUpdateStatus } from '@backspace/shared';

/**
 * The admin Updates surface.
 *
 * Its own file rather than another block in admin.ts, which already carries
 * storage, users, and settings across 400-odd lines and has no reason to also
 * own an outbound HTTP client.
 *
 * There is no POST here and no way to trigger an update from the API. Applying
 * a container update from inside the container would require mounting
 * /var/run/docker.sock, which hands the container root on the host. Backspace
 * parses uploaded media, scrapes URLs for embeds, and accepts federation
 * payloads from remote instances, so any remote-code-execution bug in it would
 * become host root the moment that socket exists. The panel hands the operator
 * an exact command instead; ./update.sh is where the effort went.
 */
export async function adminUpdateRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/instance/update-status — what this instance runs, and
  // whether anything newer exists.
  //
  // `?refresh=true` bypasses the six-hour cache for an explicit "Check again"
  // click. It cannot bypass the BACKSPACE_UPDATE_CHECK kill switch.
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/admin/instance/update-status',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const refresh = request.query.refresh === 'true';

      const channel: InstanceUpdateStatus['channel'] =
        config.updates.installChannel === 'prebuilt' ? 'prebuilt'
        : config.updates.installChannel === 'source' ? 'source'
        : 'unknown';

      // getLatestRelease never rejects; it reports failures as a reason. A
      // try/catch here would be dead code that implies otherwise.
      const result = await getLatestRelease(refresh);

      const response: InstanceUpdateStatus = {
        current: {
          version: config.version,
          commit: config.commit,
        },
        latest: result.latest,
        state: deriveState(config.version, result),
        checkedAt: result.reason === 'disabled' ? null : result.checkedAt,
        checkEnabled: config.updates.checkEnabled,
        reason: result.reason,
        channel,
      };

      return reply.code(200).send(response);
    },
  );
}
