import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getDb, getRawDb, closeDatabase } from './db/index.js';
import { checkFfmpeg } from './utils/thumbnail.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { spaceRoutes } from './routes/spaces.js';
import { channelRoutes } from './routes/channels.js';
import { messageRoutes } from './routes/messages.js';
import { uploadRoutes } from './routes/uploads.js';
import { filesRoutes } from './routes/files.js';
import { dmRoutes } from './routes/dm.js';
import { livekitRoutes } from './routes/livekit.js';
import { socialRoutes } from './routes/social.js';
import { settingsRoutes } from './routes/settings.js';
import { utilRoutes } from './routes/utils.js';
import { instanceRoutes } from './routes/instance.js';
import { invitesRoutes } from './routes/invites.js';
import { exploreRoutes } from './routes/explore.js';
import { directoryRoutes } from './routes/directory.js';
import { searchRoutes } from './routes/search.js';
import { adminRoutes } from './routes/admin.js';
import { adminUpdateRoutes } from './routes/adminUpdates.js';
import { adminTelemetryRoutes } from './routes/adminTelemetry.js';
import { gifRoutes } from './routes/gif.js';
import { federationRoutes } from './routes/federation.js';
import { cspReportRoutes } from './routes/cspReport.js';
import { buildCspHeaderValue, CSP_REPORT_GROUP, CSP_REPORT_PATH } from './utils/csp.js';
import { startFederationWorkers, stopFederationWorkers } from './utils/federationWorker.js';
import { startBackupWorker, stopBackupWorker } from './utils/backupWorker.js';
import { startTelemetryReporter, stopTelemetryReporter } from './telemetry/reporter.js';
import { startDirectoryPinger, stopDirectoryPinger } from './directory/pinger.js';
import { errorBody } from './utils/httpErrors.js';
import './utils/federationRollback.js'; // Side-effect: registers rollback callbacks for outbox terminal failures.
import { registerCallRelayHooks } from './ws/events.js';
import { resetStalePresenceOnBoot } from './utils/presenceBoot.js';

import { registerWebSocket } from './ws/handler.js';
import path from 'path';
import fs from 'fs';

async function main(): Promise<void> {
  const app = Fastify({
    // Every hop is trusted, so `request.ip` is the LEFT-MOST entry of
    // `X-Forwarded-For`, whoever put it there (verified: a request carrying
    // `x-forwarded-for: 9.9.9.9` is seen as 9.9.9.9 even when the proxy
    // appends the real address after it).
    //
    // The rate limiter keys on that address and has nothing else to key on
    // (see the limiter below), so the limit holds only while the fronting
    // proxy *overwrites* the header instead of appending to it. The bundled
    // Caddy overwrites it, which is what the shipped all-in-one deployment
    // rests on. A deployment exposed directly, or fronted by a proxy that
    // appends (nginx's `$proxy_add_x_forwarded_for` does, and that is what
    // install.sh prints for proxy mode), lets a client choose its own limiter
    // key and rotate it per request.
    //
    // That condition is stated for operators in
    // docs/systems/web-security.md section 9 and docs/systems/deployment.md,
    // "Server proxy-awareness". Narrowing this to a hop count is the real fix
    // and it would break a two-proxy deployment, so it is not a change to make
    // in passing.
    trustProxy: true,
    logger: {
      level: 'info',
    },
  });

  // The origin is deliberately reflected rather than restricted to a peer
  // allowlist. Client federation has a browser on one instance call
  // /api/instance/info, /api/auth/register and /api/auth/login directly against
  // another instance BEFORE any server-to-server peering exists, and peering can
  // legitimately be declined by an admin while that browser connection keeps
  // working (see instanceStore.connectToRemote and docs/systems/client-federation.md).
  // An allowlist would reject the whole onboarding flow.
  //
  // Reflecting is safe here only because there is no ambient credential to ride
  // on: this API has no cookies and no HTTP auth, and the bearer token is read
  // from localStorage and attached explicitly by our own client. A cross-origin
  // page cannot obtain it and the browser will not attach it. That premise is
  // enforced by test/cors-posture.test.ts. Access-Control-Allow-Credentials is
  // therefore NOT set: it grants nothing today and would make this reflection
  // genuinely unsafe the moment a cookie appeared.
  // See docs/systems/web-security.md.
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    // Tus-* and Upload-* headers are required for federated tus uploads
    // (cross-origin POST/HEAD/PATCH/DELETE on /api/files/*). Without them the
    // browser preflight blocks the request before it ever reaches the server.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Tus-Resumable',
      'Upload-Length',
      'Upload-Offset',
      'Upload-Metadata',
      'Upload-Defer-Length',
      'Upload-Concat',
      'Upload-Checksum',
      'X-HTTP-Method-Override',
    ],
    // Expose tus response headers so tus-js-client can read them across origins
    // (Location is the per-upload URL returned on POST; the rest are standard
    // tus protocol headers).
    exposedHeaders: [
      'Location',
      'Tus-Resumable',
      'Tus-Version',
      'Tus-Extension',
      'Tus-Max-Size',
      'Tus-Checksum-Algorithm',
      'Upload-Offset',
      'Upload-Length',
      'Upload-Metadata',
      'Upload-Expires',
    ],
  });

  // helmet supplies the static security headers. It is explicitly NOT allowed to
  // manage the CSP: the policy depends on runtime config and has to defer to
  // routes that set their own, so it is applied by the onSend hook below and
  // lives in exactly one place.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    // Only the TLS terminator knows whether HTTPS is actually in play. Caddy
    // owns HSTS; see Caddyfile and docs/systems/web-security.md.
    strictTransportSecurity: false,
    // Federation loads avatars and attachments across origins with plain <img>
    // and <video>. helmet's default of same-origin would block all of it.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // Not enabled: it would require CORP headers on every third-party image an
    // embed pulls in, which is not something this app controls.
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
  });

  // The policy is built once at boot because its only input is config, which
  // does not change while the process runs.
  const cspHeaderValue = buildCspHeaderValue({ livekitUrl: config.livekit.url });
  // Enforcing since 2026-09-03. It shipped report-only first and was flipped
  // only after the observation phase in docs/systems/web-security.md section 7
  // ran on two real deployments with a violation detector validated on each.
  // `Reporting-Endpoints` and the sink below stay: an enforcing policy still
  // reports, and those reports are now the only signal that this broke a flow
  // nobody exercised.
  const cspHeaderName = 'Content-Security-Policy';
  const reportingEndpoints = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

  app.addHook('onSend', async (_request, reply, payload) => {
    // A route that has already set its own policy is asserting something
    // stricter about its own response than the app policy can. routes/uploads.ts
    // sandboxes served user files under `default-src 'none'`; overwriting that
    // with the app policy would widen it. The guard and the header below now
    // carry the same name, which is why this reads as a plain "first writer
    // wins" rather than as two competing headers.
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header(cspHeaderName, cspHeaderValue);
      reply.header('Reporting-Endpoints', reportingEndpoints);
    }
    return payload;
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // The budget is per client address, and only per address. The limiter runs
    // on `onRequest`, while `authenticate` is a route `preHandler`, so nothing
    // has put a user on the request yet when this key is taken: a key that
    // reached for `request.userId` would read undefined on every request and
    // fall back here anyway. Stated plainly instead, because the consequence is
    // an operator's to know: everyone behind one NAT, VPN exit or corporate
    // proxy shares one 200-per-minute budget. `trustProxy` is on, so the
    // address is the one the fronting proxy forwards. See docs/systems/api.md,
    // "Rate limiting".
    keyGenerator: (request) => request.ip,
    // Test harnesses set DISABLE_RATE_LIMITS=1 to bypass per-IP exhaustion when
    // many tests share the loopback IP. Default unset; production unchanged.
    allowList: () => process.env.DISABLE_RATE_LIMITS === '1' || process.env.DISABLE_RATE_LIMITS === 'true',
    // The shared error shape (see localization.md) plus `retryAfter` in
    // seconds; the plugin sets the Retry-After header itself. One builder
    // covers every per-route override too, so a route that tightens its own
    // limit does not need to spell the body out again.
    errorResponseBuilder: (_request, context) => ({
      ...errorBody(429, 'rate_limited'),
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  await app.register(websocket);

  // Serve built frontend in production
  const webDistPath = path.resolve(import.meta.dirname ?? '.', '../../web/dist');
  if (fs.existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    });
  }

  // Initialize database
  getDb();

  // Reset orphaned `users.status` rows for locally-homed users. The previous
  // process's in-memory disconnect timers are gone, so any non-offline row
  // is stale by construction. Replicated (federated) rows are skipped — their
  // status is a projection of remote presence, not local WS state. Must run
  // before WS auth is accepted so the first connection broadcasts the correct
  // online transition. See utils/presenceBoot.ts.
  resetStalePresenceOnBoot();

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(uploadRoutes);
  await app.register(filesRoutes);
  await app.register(dmRoutes);
  await app.register(livekitRoutes);
  await app.register(socialRoutes);
  await app.register(settingsRoutes);
  await app.register(utilRoutes);
  await app.register(instanceRoutes);
  await app.register(invitesRoutes);
  await app.register(exploreRoutes);
  await app.register(directoryRoutes);
  await app.register(searchRoutes);
  await app.register(adminRoutes);
  await app.register(adminUpdateRoutes);
  await app.register(adminTelemetryRoutes);
  await app.register(gifRoutes);
  await app.register(federationRoutes);
  // Registered here rather than beside the hook above so it sits behind the
  // rate limiter. The sink is unauthenticated by design and writes a log line
  // per report, and @fastify/rate-limit only covers routes registered after it.
  await app.register(cspReportRoutes);
  await app.register(registerWebSocket);

  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // SPA fallback - serve index.html for non-API routes
  if (fs.existsSync(webDistPath)) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found', statusCode: 404 });
      }
      return reply.sendFile('index.html');
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Backspace server running at http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Log ffmpeg availability at startup (so admins see the warning immediately)
  checkFfmpeg();

  // Register WS-layer call relay hooks (ring-timeout fan-out).
  registerCallRelayHooks();

  // Start federation background workers (outbox delivery, file download, health check,
  // storage janitor, federated-call sentinel). Skip when DISABLE_FEDERATION_WORKERS is
  // set to '1' or 'true' (matches envBool semantics in config.ts; used by integration
  // tests to keep two-instance harnesses quiet).
  const disableWorkers = process.env.DISABLE_FEDERATION_WORKERS === '1'
    || process.env.DISABLE_FEDERATION_WORKERS === 'true';
  if (disableWorkers) {
    console.log('[startup] federation workers disabled via DISABLE_FEDERATION_WORKERS');
  } else {
    startFederationWorkers();
    // The opt-in usage reporter, behind the same guard as the federation
    // workers so an integration harness starts no background timers. It sends
    // nothing at all unless an admin has switched reporting on.
    startTelemetryReporter();
  }

  startBackupWorker();

  // The space directory pinger stays outside the workers guard on purpose:
  // the two-instance harness disables the workers and still needs the pinger,
  // pointed at a local stub. It has its own guard, an empty DIRECTORY_ENDPOINT.
  startDirectoryPinger();

  const shutdown = async () => {
    console.log('Shutting down...');
    stopFederationWorkers();
    stopTelemetryReporter();
    stopDirectoryPinger();
    stopBackupWorker();
    await app.close();
    closeDatabase(); // checkpoints WAL — leaves a complete on-disk file
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
