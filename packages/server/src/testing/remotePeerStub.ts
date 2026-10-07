import { buildFederationHeaders } from '../utils/federationAuth.js';

/**
 * A `fetch` stand-in for a remote Backspace instance in handshake unit tests.
 *
 * `/api/federation/peer/accept` records the secret it was sent and answers with
 * `accept(body)`. `/api/federation/epoch` answers the way a remote that adopted
 * that secret does: its body `{ instanceId }` signed with the secret, so the
 * sender's verify-before-activate check (`probeEpoch`) passes. Pass
 * `epoch: 'mismatch'` for a remote that holds some other secret (401),
 * `epoch: 'none'` for one that holds no row for us (403), or
 * `epoch: 'unavailable'` for one whose check fails without an answer (503).
 */
export function remotePeerStub(opts: {
  accept: (body: Record<string, unknown>) => Response | Promise<Response>;
  instanceId?: string;
  origin?: string;
  epoch?: 'adopted' | 'mismatch' | 'none' | 'unavailable';
}): typeof globalThis.fetch & { acceptBodies: Array<Record<string, unknown>> } {
  let adoptedSecret = '';
  const acceptBodies: Array<Record<string, unknown>> = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/api/federation/peer/accept')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      acceptBodies.push(body);
      adoptedSecret = String(body.hmacSecret);
      return opts.accept(body);
    }
    if (u.endsWith('/api/federation/epoch')) {
      if (opts.epoch === 'mismatch') return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
      if (opts.epoch === 'none') return new Response(JSON.stringify({ error: 'Not peered' }), { status: 403 });
      if (opts.epoch === 'unavailable') return new Response('Service Unavailable', { status: 503 });
      const body = JSON.stringify({ instanceId: opts.instanceId ?? 'remote-epoch' });
      const headers = buildFederationHeaders(body, adoptedSecret, opts.origin ?? 'https://remote.example');
      return new Response(body, { status: 200, headers });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof globalThis.fetch & { acceptBodies: Array<Record<string, unknown>> };
  stub.acceptBodies = acceptBodies;
  return stub;
}

/** A JSON response with the given status. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
