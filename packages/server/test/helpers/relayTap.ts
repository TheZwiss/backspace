import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FederationRelayEvent, FederationRelayRequest } from '@backspace/shared';

/** One request the tap saw, captured before it was forwarded upstream. */
export interface TappedRequest {
  method: string;
  path: string;
  origin: string | null; // X-Federation-Origin, the sender's claimed identity
  body: string;
}

/**
 * A transparent recording reverse proxy that sits in front of a real spawned
 * instance.
 *
 * It is a TAP, not a mock: every request is recorded and then forwarded verbatim
 * (same method, headers and body bytes, so the HMAC signature still verifies) to
 * the real instance, and the real response is piped back. Peering, the signed
 * `/epoch` probe and relay delivery all behave exactly as they would without it.
 *
 * Why it exists: assertions of the form "peer B received tokens ONLY for the
 * members B homes" are about the bytes on the wire. The receiving instance
 * cannot report what it did *not* get, so the only place that fact is observable
 * is in transit. Point the peer's origin at the tap (peer with `tap.origin`
 * instead of `instance.origin`) and the whole S2S conversation becomes readable.
 */
export interface RelayTap {
  /** `http://127.0.0.1:<ephemeral>` — use this as the peer origin. */
  origin: string;
  /**
   * Point the tap at the instance it fronts.
   *
   * A tap must exist before the instances boot (its origin is what they are
   * peered at), but an instance's own origin is only known once it has bound its
   * ephemeral port — so the upstream is wired up in between. Until it is set,
   * the tap answers 502 like an unreachable peer.
   */
  setTarget(origin: string): void;
  /** Every request seen, in arrival order. */
  requests: TappedRequest[];
  /** Just the POSTs to /api/federation/relay, parsed. */
  relayBatches(): FederationRelayRequest[];
  /** Flattened relay events across every recorded batch. */
  relayEvents(): FederationRelayEvent[];
  /**
   * From now on, forward relay POSTs as usual but hold back the upstream's
   * RESPONSE until the returned function is called.
   *
   * The receiver has already applied the batch while its answer waits here, so
   * the sender sees a delivery that is on the wire and not yet acknowledged,
   * for as long as the test likes: the window in which a sender queues a newer
   * event for the same entity. Other paths (handshake, epoch, lookups) are
   * never held. Keep the hold shorter than the sender's 30 s fetch timeout.
   * `close()` releases anything still held.
   */
  holdRelayResponses(): () => void;
  /**
   * Answer the next `count` relay POSTs with a 503 instead of forwarding them,
   * as a peer that is briefly overloaded would. The sender sees a failed
   * attempt and retries on its backoff schedule.
   */
  failNextRelays(count: number): void;
  /**
   * Forward the next relay POST whose batch satisfies `matches` as usual, so
   * the receiver applies it, but answer the sender 502 instead of the
   * receiver's answer, as a proxy that timed out on its way back would. The
   * sender cannot tell this from a delivery that never arrived: the batch's
   * outcome is unknown. Combined with `holdRelayResponses`, the 502 goes back
   * when the hold is released.
   */
  loseRelayAnswer(matches: (batch: FederationRelayRequest) => boolean): void;
  close(): Promise<void>;
}

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). `host` is dropped so
// undici sets the upstream host; `content-length` is dropped so it is recomputed
// from the body we actually send.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-length',
]);

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * A relay POST body as a batch. A malformed body counts as a batch with no
 * events rather than throwing inside the tap or an assertion helper.
 */
function parseRelayBatch(body: string): FederationRelayRequest {
  try {
    return JSON.parse(body) as FederationRelayRequest;
  } catch {
    return { version: 1, sourceInstance: '', events: [] };
  }
}

export async function startRelayTap(targetOrigin?: string): Promise<RelayTap> {
  const requests: TappedRequest[] = [];
  let target: string | null = targetOrigin ?? null;
  // While set, relay responses wait on this promise before going back.
  let relayResponseGate: { opened: Promise<void>; open: () => void } | null = null;
  // Relay POSTs still to be answered 503 without being forwarded.
  let relaysToFail = 0;
  // The next relay POST this matches is forwarded, and then answered 502.
  let loseAnswerTo: ((batch: FederationRelayRequest) => boolean) | null = null;

  const server = http.createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '/';
      const body = await readBody(req);
      const originHeader = req.headers['x-federation-origin'];
      requests.push({
        method: req.method ?? 'GET',
        path,
        origin: typeof originHeader === 'string' ? originHeader : null,
        body,
      });

      const forwardHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
        if (typeof v === 'string') forwardHeaders[k] = v;
        else if (Array.isArray(v)) forwardHeaders[k] = v.join(', ');
      }

      const method = req.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;

      if (!target) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay tap has no upstream yet' }));
        return;
      }

      const isRelay = method === 'POST' && path.startsWith('/api/federation/relay');
      if (isRelay && relaysToFail > 0) {
        relaysToFail--;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay tap failed this delivery on purpose' }));
        return;
      }

      try {
        const upstream = await fetch(`${target}${path}`, {
          method,
          headers: forwardHeaders,
          body: hasBody ? body : undefined,
        });
        const text = await upstream.text();
        const gate = relayResponseGate;
        const loseAnswer = isRelay && loseAnswerTo !== null && loseAnswerTo(parseRelayBatch(body));
        if (loseAnswer) loseAnswerTo = null;
        if (gate && isRelay) {
          await gate.opened;
        }
        if (loseAnswer) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'relay tap lost this answer on purpose' }));
          return;
        }
        const outHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
          outHeaders[key] = value;
        });
        res.writeHead(upstream.status, outHeaders);
        res.end(text);
      } catch (err) {
        // Upstream unreachable — answer like a dead peer so the sender's own
        // failure handling runs, rather than hanging the socket.
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `relay tap upstream failed: ${(err as Error).message}` }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  const relayBatches = (): FederationRelayRequest[] => requests
    .filter(r => r.method === 'POST' && r.path.startsWith('/api/federation/relay'))
    .map(r => parseRelayBatch(r.body));

  return {
    origin,
    setTarget: (upstream: string) => {
      target = upstream;
    },
    requests,
    relayBatches,
    relayEvents: () => relayBatches().flatMap(b => b.events ?? []),
    holdRelayResponses: () => {
      if (relayResponseGate) throw new Error('relay responses are already held');
      let resolveOpened: () => void = () => {};
      const opened = new Promise<void>(resolve => { resolveOpened = resolve; });
      const gate = {
        opened,
        open: () => {
          if (relayResponseGate === gate) relayResponseGate = null;
          resolveOpened();
        },
      };
      relayResponseGate = gate;
      return gate.open;
    },
    failNextRelays: (count: number) => {
      relaysToFail = count;
    },
    loseRelayAnswer: (matches: (batch: FederationRelayRequest) => boolean) => {
      loseAnswerTo = matches;
    },
    close: () =>
      new Promise<void>((resolve) => {
        relayResponseGate?.open();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
