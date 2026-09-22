import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { DirectoryDocument, DirectoryPingError, InstanceAdminSettings, Space } from '@backspace/shared';
import { bootTwoInstances, readInstanceLog, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';

// Boots two real instances whose pingers point at a stub hub in this process.
// Every step waits on a 3 second debounce plus a real fetch, so the 5 s unit
// default is too tight; the polls below are bounded on their own.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The hub, reduced to what section 3 of the spec makes it: a ping is a hint,
 * the fetch is the truth. On every ping it fetches the origin's document
 * itself and keeps every document it read, per origin, in arrival order, so a
 * test can ask for the LATEST document and for "a document that arrived after
 * this point". It never merges: what it stores is exactly what it read.
 *
 * `answer` switches what the ping gets: 'ok' fetches and answers 204,
 * 'unreachable' skips the fetch and answers 502 { reason: 'unreachable' },
 * which is the hub's word for "I could not read you". A mode rather than a
 * one-shot flag on purpose: the pinger's minute tick may send an extra ping
 * while dirty, and a one-shot answer consumed by that tick would let the
 * debounce ping through as a success and make the step flaky.
 */
interface StubHub {
  url: string;
  answer: 'ok' | 'unreachable';
  pings: Array<{ origin: string; status: number }>;
  documents: Map<string, DirectoryDocument[]>;
  latest(origin: string): DirectoryDocument | null;
  count(origin: string): number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startStubHub(): Promise<StubHub> {
  const pings: StubHub['pings'] = [];
  const documents = new Map<string, DirectoryDocument[]>();
  const hub: StubHub = {
    url: '',
    answer: 'ok',
    pings,
    documents,
    latest(origin) {
      const docs = documents.get(origin);
      return docs && docs.length > 0 ? docs[docs.length - 1]! : null;
    },
    count(origin) {
      return documents.get(origin)?.length ?? 0;
    },
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/ping') {
        res.writeHead(404).end();
        return;
      }
      let origin = '';
      try {
        const body = JSON.parse(await readBody(req)) as { schema?: unknown; origin?: unknown };
        if (body.schema !== 1 || typeof body.origin !== 'string') {
          res.writeHead(400).end();
          return;
        }
        origin = body.origin;
      } catch {
        res.writeHead(400).end();
        return;
      }

      const reply = (status: number, json?: Record<string, unknown>) => {
        pings.push({ origin, status });
        if (json === undefined) {
          res.writeHead(status).end();
        } else {
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
        }
      };

      if (hub.answer === 'unreachable') {
        reply(502, { reason: 'unreachable' });
        return;
      }

      // Fact 1: the ping proves nothing, the fetch proves everything.
      let doc: DirectoryDocument;
      try {
        const r = await fetch(`${origin}/api/directory/spaces`, { signal: AbortSignal.timeout(5_000) });
        if (!r.ok) {
          reply(502, { reason: 'status' });
          return;
        }
        doc = await r.json() as DirectoryDocument;
      } catch {
        reply(502, { reason: 'unreachable' });
        return;
      }
      if (doc.origin !== origin) {
        reply(502, { reason: 'origin-mismatch' });
        return;
      }
      // Fact 3: replace, never merge. Kept as a history so tests can tell a new
      // document from the previous one; the "current" set is always the last.
      const history = documents.get(origin) ?? [];
      history.push(doc);
      documents.set(origin, history);
      reply(204);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  hub.url = `http://127.0.0.1:${port}`;
  hub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return hub;
}

/** Poll `check` every 200 ms for up to `timeoutMs`; the last value is returned so a failing assertion shows it. */
async function waitFor<T>(check: () => Promise<T> | T, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await check();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    last = await check();
  }
  return last;
}

async function api<T>(user: TestUser, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${user.origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

let hub: StubHub;
let harness: TwoInstanceHarness;
let admin: TestUser;

beforeAll(async () => {
  hub = await startStubHub();
  harness = await bootTwoInstances({ directoryEndpoint: hub.url, publicOriginAsTransport: true });
  // First registered user on an instance is its admin.
  admin = await registerLocal(harness.home, 'directory_admin');
}, 90_000);

afterAll(async () => {
  await harness?.cleanup();
  await hub?.close();
});

describe('space directory end to end', () => {
  let spaceId = '';
  const home = () => harness.home.origin;

  it('starts a pinger on every instance and sends nothing while unlisted', async () => {
    for (const inst of [harness.home, harness.remote]) {
      const log = await readInstanceLog(inst);
      expect(log).toContain(`[directory] pinger started, hub ${hub.url}, origin ${inst.origin}`);
      expect(log).not.toContain('pinger disabled');
    }
    // Neither instance is enabled or dirty at boot, so the boot ping is not owed.
    expect(hub.pings).toEqual([]);
  });

  it('enabling the directory pings the hub, which reads an empty document', async () => {
    const patched = await api<InstanceAdminSettings>(admin, 'PATCH', '/api/settings/instance', {
      discoveryEnabled: true,
      directoryEnabled: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.directoryEnabled).toBe(true);

    const doc = await waitFor(() => hub.latest(home()), (d) => d !== null);
    expect(doc).not.toBeNull();
    expect(doc!.schema).toBe(1);
    expect(doc!.origin).toBe(home());
    expect(doc!.spaces).toEqual([]);

    const settings = await waitFor(
      async () => (await api<InstanceAdminSettings>(admin, 'GET', '/api/settings/instance')).json,
      (s) => s.directoryLastPingAt !== null,
    );
    expect(settings.directoryLastPingAt).not.toBeNull();
    expect(settings.directoryLastError).toBeNull();
  });

  it('listing a public space puts it in the next document the hub reads', async () => {
    const created = await api<Space>(admin, 'POST', '/api/spaces', { name: 'Listed Space', visibility: 'public' });
    expect(created.status).toBe(201);
    spaceId = created.json.id;
    expect(created.json.directoryListed).toBe(false);

    // Creating an unlisted space is not a change to the served document.
    const before = hub.count(home());

    const listed = await api<Space>(admin, 'PATCH', `/api/spaces/${spaceId}`, { directoryListed: true });
    expect(listed.status).toBe(200);
    expect(listed.json.directoryListed).toBe(true);

    const doc = await waitFor(
      () => hub.latest(home()),
      (d) => d !== null && d.spaces.some((s) => s.id === spaceId),
    );
    expect(hub.count(home())).toBeGreaterThan(before);
    expect(doc!.spaces).toHaveLength(1);
    const entry = doc!.spaces[0]!;
    expect(entry.id).toBe(spaceId);
    expect(entry.name).toBe('Listed Space');
    expect(entry.visibility).toBe('public');
    expect(entry.memberCount).toBe(1);
  });

  it('delisting the space: the next document the hub reads has no spaces', async () => {
    const before = hub.count(home());
    const res = await api<Space>(admin, 'PATCH', `/api/spaces/${spaceId}`, { directoryListed: false });
    expect(res.status).toBe(200);
    expect(res.json.directoryListed).toBe(false);

    // A delist is not a message type: it is the absence of the space in the
    // next fetch, which the pinger triggers straight away.
    const count = await waitFor(() => hub.count(home()), (n) => n > before);
    expect(count).toBeGreaterThan(before);
    expect(hub.latest(home())!.spaces).toEqual([]);
  });

  it('switching the directory off: the next document the hub reads has no spaces', async () => {
    // Re-list first so the switch has something to take out of the document.
    const relisted = await api<Space>(admin, 'PATCH', `/api/spaces/${spaceId}`, { directoryListed: true });
    expect(relisted.status).toBe(200);
    await waitFor(() => hub.latest(home()), (d) => d !== null && d.spaces.some((s) => s.id === spaceId));

    const before = hub.count(home());
    const off = await api<InstanceAdminSettings>(admin, 'PATCH', '/api/settings/instance', { directoryEnabled: false });
    expect(off.status).toBe(200);
    expect(off.json.directoryEnabled).toBe(false);

    const count = await waitFor(() => hub.count(home()), (n) => n > before);
    expect(count).toBeGreaterThan(before);
    // The envelope is still served (the endpoint never 404s), only empty, so
    // the hub's read is a success that clears the rows.
    const doc = hub.latest(home())!;
    expect(doc.origin).toBe(home());
    expect(doc.spaces).toEqual([]);

    // The space itself still remembers the owner's wish for when the admin switches back on.
    const space = await api<Space>(admin, 'GET', `/api/spaces/${spaceId}`);
    expect(space.status).toBe(200);
    expect(space.json.directoryListed).toBe(true);
  });

  it('a hub that cannot read the instance is surfaced to the admin, and the next change after recovery clears it', async () => {
    hub.answer = 'unreachable';
    const pingsBefore = hub.pings.length;
    const on = await api<InstanceAdminSettings>(admin, 'PATCH', '/api/settings/instance', { directoryEnabled: true });
    expect(on.status).toBe(200);

    const failed = await waitFor(
      async () => (await api<InstanceAdminSettings>(admin, 'GET', '/api/settings/instance')).json,
      (s) => s.directoryLastError !== null,
    );
    const error = failed.directoryLastError as DirectoryPingError | null;
    expect(error).not.toBeNull();
    expect(error!.status).toBe('fetch');
    expect(error!.reason).toBe('unreachable');
    expect(typeof error!.at).toBe('number');
    expect(hub.pings.slice(pingsBefore).every((p) => p.origin === home() && p.status === 502)).toBe(true);
    // Nothing was fetched, so nothing was stored: a failed fetch never deletes (fact 2).
    const storedBefore = hub.count(home());

    // The hub is healthy again. The pinger is now in a 1 minute backoff, so
    // the proof is a NEW change: the debounce sends regardless of backoff
    // because an edit is new information.
    hub.answer = 'ok';
    const renamed = await api<InstanceAdminSettings>(admin, 'PATCH', '/api/settings/instance', { instanceName: 'Home Renamed' });
    expect(renamed.status).toBe(200);

    const recovered = await waitFor(
      async () => (await api<InstanceAdminSettings>(admin, 'GET', '/api/settings/instance')).json,
      (s) => s.directoryLastError === null,
    );
    expect(recovered.directoryLastError).toBeNull();
    expect(recovered.directoryLastPingAt).toBeGreaterThan(error!.at);

    // The recovery ping carried the current document: the rename and the
    // still-listed space, since the directory is on again.
    expect(hub.count(home())).toBeGreaterThan(storedBefore);
    const doc = hub.latest(home())!;
    expect(doc.instance.name).toBe('Home Renamed');
    expect(doc.spaces.map((s) => s.id)).toEqual([spaceId]);
  });

  it('the other instance, never enabled, never pinged', () => {
    expect(hub.pings.filter((p) => p.origin === harness.remote.origin)).toEqual([]);
    expect(hub.count(harness.remote.origin)).toBe(0);
  });
});
