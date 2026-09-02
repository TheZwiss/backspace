# Plan C: WS3 Web/Server Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Backspace a Content Security Policy generated at runtime from instance config, a correct and honestly-reasoned CORS posture, and a documented ownership split for transport-level headers, without breaking federation, voice, embeds or uploads.

**Architecture:** A pure policy-builder module turns `config` into a CSP directive string. A single `onSend` hook applies it, deferring to any route that has already set its own stricter policy. `@fastify/helmet` supplies the remaining static security headers but is explicitly told not to manage CSP, so there is exactly one place the policy is produced. Reports land on an in-app sink that logs them. The policy ships **report-only** and the flip to enforcing is the last task in this plan, gated on real field data rather than on a green test run.

**Tech Stack:** Fastify 4, `@fastify/helmet` 11.1.1, `@fastify/cors` 9, Vitest, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-07-10-security-scanning-hardening-design.md` §WS3 (lines 240-292).

**Master plan:** `docs/superpowers/plans/2026-09-02-security-pass-master.md`, Track C.

---

## Corrections to the spec

The spec was written on 2026-07-10. Three of its premises were checked against
the code on 2026-09-02 and do not hold. This plan deviates deliberately. Do not
"fix" these back toward the spec.

**1. The registry-backed CORS callback is wrong and must not be built.**

The spec says to replace `origin: true` with a callback backed by the live
federation-peer registry. Read `packages/web/src/stores/instanceStore.ts:370-518`.
When a user on instance A connects to instance B, the browser calls, in order:
`tempClient.instance.info()`, `tempClient.auth.register()`, `tempClient.auth.login()`,
then opens a WebSocket, and only **after all of that** calls
`api.federation.ensurePeered()` on its own server. At the moment the browser
registers, B has no row for A. A registry-backed callback rejects the entire
onboarding flow.

It is also permanent, not merely a race. `ensurePeered` can return
`admin_required` or `rejected` (see `docs/systems/client-federation.md` §
"Peering-status taxonomy"), in which case B never gets a row for A at all, while
that browser connection is expected to keep working indefinitely.

**2. CORS is not a security boundary for this app, and `credentials: true` is the real defect.**

Verified: `grep -rn "cookie" packages/server/src` returns exactly one hit, and it
is the string `youtube-nocookie.com` in `embedClassifier.ts`. There is no cookie
plugin, no `setCookie`, no session middleware. Auth is `Authorization: Bearer`
read from `localStorage` (`packages/web/src/stores/authStore.ts:42`,
`packages/web/src/api/client.ts:348`), and no `fetch` in the web package sets a
`credentials` mode.

A cross-origin page therefore cannot make an authenticated request to a Backspace
API: it has no way to obtain the token and no ambient credential is attached.
Restricting `Access-Control-Allow-Origin` would buy nothing and cost federation.
What must go is `credentials: true` at `packages/server/src/index.ts:47`. It is
dead configuration today, and it is the half of the reflected-origin pair that
turns into a real vulnerability the day somebody adds a cookie.

**3. The two-instance + LiveKit Docker rig is not needed and must not be built.**

The spec schedules a Docker/Caddy/LiveKit compose rig for validating CSP and
CORS, shared with Track E's DAST job. With CORS staying permissive there is
nothing left for it to validate on that side, and `packages/server/test/helpers/twoInstanceHarness.ts`
already spawns real Fastify instances over real HTTP with an `enableLiveKit`
option that sets `LIVEKIT_URL=wss://livekit.test.local`. That is sufficient to
assert the runtime-built policy against a live server. Track E's ZAP baseline
runs against a single container bypassing Caddy, as its own brief already says.

---

## Global Constraints

Every task's requirements implicitly include this section.

- Node is pinned `>=20 <21`. Do not change it here.
- TypeScript strict, no `any`, no placeholder code, no TODO comments.
- **`@fastify/helmet` must be `^11.1.1`.** The 12.x line depends on
  `fastify-plugin@^5` and 13.x on `^6`; both target Fastify 5. This repo is on
  Fastify 4 and every other plugin is pinned to its Fastify 4 major
  (`@fastify/cors@^9`, `rate-limit@^9`, `static@^7`, `websocket@^10`). Verified
  2026-09-02 via `npm view @fastify/helmet@<v> dependencies`.
- **No vulnerability or exploit detail in any public artifact.** Commit
  messages, PR titles and bodies, release notes, tracked files. Describe changes
  behaviourally.
- **No em dashes and no AI register** in commits, PR text or docs. See memory
  `no-ai-slop-writing`.
- Never commit as `alxtrading94@gmail.com`. Use the TheZwiss noreply address.
- Update `docs/systems/*.md` for structural change. This plan adds a new
  subsystem doc and a CLAUDE.md row, in Task 7.
- **A negative assertion must be proved capable of failing.** This codebase has
  produced seven separate cases of tests that passed vacuously. For every test
  in this plan that asserts a header is absent, a directive is missing, or a
  request is rejected, temporarily break the implementation and confirm the test
  goes red before committing. State the observed failure in the commit or the
  task report.

**Verification commands**

```bash
cd packages/server && npx vitest run          # 974 tests / 115 files at plan start
cd packages/server && npx tsc --noEmit
cd packages/server && pnpm typecheck:e2e
cd packages/web && npx vitest run             # 488 tests / 60 files at plan start
cd packages/web && npx tsc --noEmit && npx vite build
pnpm --filter @backspace/shared build
```

If `npx vitest run` fails with a native binding error, see memory
`running-server-tests-node`.

---

## File Structure

**Created**

| File | Responsibility |
|------|----------------|
| `packages/server/src/utils/csp.ts` | Pure policy builder. Turns config into a directive map and a header string. No Fastify imports, no I/O. |
| `packages/server/src/utils/csp.test.ts` | Unit tests for the builder. |
| `packages/server/src/routes/cspReport.ts` | The violation sink, plus the two content-type parsers browsers use to post reports. |
| `packages/server/src/routes/cspReport.test.ts` | Unit tests for the sink. |
| `packages/server/test/http-security-headers.test.ts` | Live-server assertions against a spawned instance, LiveKit on and off. |
| `packages/server/test/cors-posture.test.ts` | Live-server CORS assertions, including the guard that no credentialed path exists. |
| `docs/systems/web-security.md` | The subsystem doc: policy contents, why each non-obvious directive is there, the header ownership split, and the rollout state. |

**Modified**

| File | Change |
|------|--------|
| `packages/server/package.json` | Add `@fastify/helmet@^11.1.1`. |
| `packages/server/src/index.ts` | Drop `credentials: true`; register helmet with CSP disabled; install the CSP `onSend` hook; register the report route. |
| `packages/web/index.html` | Meta CSP, script/object/base directives only. |
| `Caddyfile` | HSTS only, with a comment stating the split. |
| `docs/systems/api.md` | The `POST /api/csp-report` row. |
| `CLAUDE.md` | Subsystem-table row for `web-security.md`. |

---

## Task 1: Correct the CORS posture

`credentials: true` is unused and is the dangerous half of a reflected origin.
Remove it, and leave behind a test that fails if anybody reintroduces ambient
credentials without revisiting the whole posture.

**Files:**
- Modify: `packages/server/src/index.ts:45-47`
- Test: `packages/server/test/cors-posture.test.ts` (create)

**Interfaces:**
- Consumes: `bootTwoInstances` from `test/helpers/twoInstanceHarness.js`.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Write the failing test**

Create `packages/server/test/cors-posture.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, '../src');

describe('CORS posture', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstances();
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('reflects an arbitrary browser origin, because client federation requires it', async () => {
    // A browser on instance A calls register/login on instance B before any
    // S2S peering exists. See instanceStore.connectToRemote.
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: h.home.origin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(h.home.origin);
  });

  it('reflects Origin: null so the desktop picker can probe from file://', async () => {
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
  });

  it('never grants credentialed cross-origin access', async () => {
    const res = await fetch(`${h.remote.origin}/api/instance/info`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('never grants credentialed access on a preflight either', async () => {
    const res = await fetch(`${h.remote.origin}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('has no ambient-credential mechanism anywhere in the server', async () => {
    // The reason a reflected origin is safe here is that there is nothing for a
    // cross-origin page to ride on: no cookies, no HTTP auth, tokens live in
    // localStorage and are attached explicitly. If that ever stops being true,
    // the whole posture in docs/systems/web-security.md has to be revisited,
    // so fail loudly rather than let it drift.
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rniE "setcookie|@fastify/cookie|req(uest)?\\.cookies|['\\"]set-cookie['\\"]" ${SERVER_SRC} || true`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(hits).toEqual([]);
  });

  it('still declares the tus headers federated uploads need', async () => {
    const res = await fetch(`${h.remote.origin}/api/files/probe`, {
      method: 'OPTIONS',
      headers: {
        Origin: h.home.origin,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'upload-offset,tus-resumable',
      },
    });
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowed).toContain('upload-offset');
    expect(allowed).toContain('tus-resumable');
  });

  it('serves a source file that documents why the origin stays reflected', async () => {
    const src = await readFile(path.join(SERVER_SRC, 'index.ts'), 'utf8');
    expect(src).toMatch(/bearer/i);
    expect(src).not.toMatch(/credentials:\s*true/);
  });
});
```

- [x] **Step 2: Run it and watch the credential assertions fail**

Run: `cd packages/server && npx vitest run test/cors-posture.test.ts`
Expected: the two `access-control-allow-credentials` tests FAIL (the header is
present and reads `true`), and the last test FAILS on `credentials: true` still
being in the source. The reflection and tus tests PASS already. If the
credential tests pass before the change, stop: the test is not exercising what
it claims.

- [x] **Step 3: Make the change**

In `packages/server/src/index.ts`, replace the `await app.register(cors, {`
opening and its `origin`/`credentials` lines with:

```ts
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
```

Leave `allowedHeaders` and `exposedHeaders` exactly as they are.

- [x] **Step 4: Run the test again**

Run: `cd packages/server && npx vitest run test/cors-posture.test.ts`
Expected: all 7 PASS.

- [x] **Step 5: Run the full server suite**

Run: `cd packages/server && npx vitest run && npx tsc --noEmit`
Expected: no regressions, `tsc` exit 0. Some suite may assert on the credentials
header; if one does, it encoded the old posture and should be updated, not
worked around.

- [x] **Step 6: Commit**

```bash
git add packages/server/src/index.ts packages/server/test/cors-posture.test.ts
git commit -m "security(server): stop advertising credentialed cross-origin access

The API has no cookies and no HTTP auth. Bearer tokens are read from
localStorage and attached by the client, so Access-Control-Allow-Credentials
granted nothing while making the reflected origin unsafe if a cookie were
ever introduced. Reflection itself has to stay: client federation registers
and logs in against a remote instance before any peering exists.

Adds a test that fails if a cookie or credentialed path appears."
```

---

## Task 2: The policy builder

A pure module so the policy can be unit-tested without booting anything, and so
there is exactly one definition of the policy in the codebase.

**Files:**
- Create: `packages/server/src/utils/csp.ts`
- Test: `packages/server/src/utils/csp.test.ts`

**Interfaces:**
- Consumes: nothing. This module must not import `config`; it takes what it
  needs as arguments, so tests can drive it directly.
- Produces:
  ```ts
  export interface CspInput { livekitUrl?: string | null }
  export const EMBED_FRAME_ORIGINS: readonly string[];
  export function buildCspDirectives(input: CspInput): Record<string, string[]>;
  export function buildCspHeaderValue(input: CspInput): string;
  ```
  Task 4 consumes `buildCspHeaderValue`.

- [x] **Step 1: Write the failing test**

Create `packages/server/src/utils/csp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCspDirectives, buildCspHeaderValue, EMBED_FRAME_ORIGINS } from './csp.js';

const directivesOf = (input: Parameters<typeof buildCspDirectives>[0]) =>
  buildCspDirectives(input);

describe('buildCspDirectives', () => {
  it('locks down the directives that actually stop script injection', () => {
    const d = directivesOf({});
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
  });

  it("never allows 'unsafe-eval' or 'unsafe-inline' in script-src", () => {
    const d = directivesOf({});
    expect(d['script-src']).not.toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
  });

  it("allows 'wasm-unsafe-eval' because the noise suppressor is WebAssembly", () => {
    // packages/web/src/audio/AudioManager.ts:399 instantiates rnnoise.wasm.
    // Without this directive, noise suppression fails to initialise.
    expect(directivesOf({})['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it('allows blob: workers because the WebSocket heartbeat is one', () => {
    // packages/web/src/hooks/useWebSocket.ts:90 runs the 15s keepalive in a
    // Worker built from a blob URL. worker-src falls back to script-src, so
    // without this every connection silently loses its heartbeat.
    const d = directivesOf({});
    expect(d['worker-src']).toContain('blob:');
    expect(d['worker-src']).toContain("'self'");
  });

  it('allows the three embed providers to be framed and nothing else', () => {
    const d = directivesOf({});
    expect(d['frame-src']).toEqual([
      'https://www.youtube-nocookie.com',
      'https://player.vimeo.com',
      'https://open.spotify.com',
    ]);
    expect(EMBED_FRAME_ORIGINS).toEqual(d['frame-src']);
  });

  it('keeps content origins broad, because the content is arbitrary', () => {
    const d = directivesOf({});
    for (const key of ['img-src', 'media-src']) {
      expect(d[key]).toContain('https:');
      expect(d[key]).toContain('data:');
      expect(d[key]).toContain('blob:');
    }
  });

  it('adds the configured LiveKit origin to connect-src', () => {
    const d = directivesOf({ livekitUrl: 'wss://voice.example.org' });
    expect(d['connect-src']).toContain('wss://voice.example.org');
  });

  it('adds a plain ws:// LiveKit origin too, for LAN self-hosters', () => {
    // This is the case the wildcard does not cover: connect-src lists wss: but
    // not ws:, so an operator running LiveKit unencrypted on a LAN needs the
    // exact origin. This is why the policy is built at runtime at all.
    const d = directivesOf({ livekitUrl: 'ws://192.168.1.50:7880' });
    expect(d['connect-src']).toContain('ws://192.168.1.50:7880');
  });

  it('normalises a LiveKit url with a path down to its origin', () => {
    const d = directivesOf({ livekitUrl: 'wss://voice.example.org/livekit/' });
    expect(d['connect-src']).toContain('wss://voice.example.org');
    expect(d['connect-src']).not.toContain('wss://voice.example.org/livekit/');
  });

  it('omits any LiveKit entry when voice is not configured', () => {
    for (const livekitUrl of [undefined, null, '', '   ']) {
      const d = directivesOf({ livekitUrl });
      expect(d['connect-src'].some((s) => s.includes('livekit'))).toBe(false);
    }
  });

  it('ignores an unparseable LiveKit url instead of emitting a broken directive', () => {
    const d = directivesOf({ livekitUrl: 'not a url' });
    expect(d['connect-src'].join(' ')).not.toContain('not a url');
  });

  it('points reports at the in-app sink', () => {
    expect(directivesOf({})['report-uri']).toEqual(['/api/csp-report']);
    expect(directivesOf({})['report-to']).toEqual(['csp']);
  });
});

describe('buildCspHeaderValue', () => {
  it('serialises to a single-line header with directives separated by semicolons', () => {
    const v = buildCspHeaderValue({ livekitUrl: 'wss://voice.example.org' });
    expect(v).not.toContain('\n');
    expect(v).toContain("default-src 'self'");
    expect(v).toContain('wss://voice.example.org');
    expect(v.split('; ').length).toBe(Object.keys(buildCspDirectives({})).length);
  });

  it('emits no empty directive segments', () => {
    for (const segment of buildCspHeaderValue({}).split('; ')) {
      expect(segment.trim()).not.toBe('');
      expect(segment.split(' ').length).toBeGreaterThan(1);
    }
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx vitest run src/utils/csp.test.ts`
Expected: FAIL, `Cannot find module './csp.js'`.

- [x] **Step 3: Write the implementation**

Create `packages/server/src/utils/csp.ts`:

```ts
/**
 * Content Security Policy construction.
 *
 * The policy is built at runtime rather than written as a constant string
 * because one directive depends on operator configuration: the LiveKit
 * signalling origin. `connect-src` lists the `wss:` scheme, which covers a
 * TLS-terminated LiveKit, but an operator running LiveKit unencrypted on a LAN
 * needs their exact `ws://host:port` listed, and no build-time string can know
 * it.
 *
 * What this policy is and is not for. Backspace renders arbitrary user content
 * and federates with instances discovered at runtime, so `img-src`, `media-src`
 * and `connect-src` cannot be meaningfully constrained: a link embed pulls its
 * preview image from any site on the web, and a peer's API origin is not
 * knowable in advance. The directives that carry the weight here are the ones
 * that stop script injection and clickjacking: `script-src`, `object-src`,
 * `base-uri`, `form-action` and `frame-ancestors`. The permissive content
 * directives are a deliberate, documented trade, not an oversight.
 *
 * See docs/systems/web-security.md.
 */

export interface CspInput {
  /** `config.livekit.url`. Absent, empty or unparseable means voice is off. */
  livekitUrl?: string | null;
}

/**
 * The exact origins `utils/embedClassifier.ts` produces `embedUrl` values for.
 * `frame-src` defaults to `default-src`, so without these three the YouTube,
 * Vimeo and Spotify embeds render as blank boxes.
 */
export const EMBED_FRAME_ORIGINS: readonly string[] = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://open.spotify.com',
];

/** Path of the in-app violation sink. Must match routes/cspReport.ts. */
export const CSP_REPORT_PATH = '/api/csp-report';

/** Name of the Reporting-Endpoints group used by `report-to`. */
export const CSP_REPORT_GROUP = 'csp';

function livekitOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:' &&
        url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    // `origin` drops any path, query and trailing slash, which is what a CSP
    // source expression wants. A URL like wss://host/livekit/ would otherwise
    // be emitted verbatim and match nothing.
    return url.origin;
  } catch {
    return null;
  }
}

export function buildCspDirectives(input: CspInput): Record<string, string[]> {
  const livekit = livekitOrigin(input.livekitUrl);

  // Peers are discovered at runtime and are not enumerable, so the schemes are
  // listed rather than the hosts. `http:` is present alongside `https:` because
  // self-hosters do run instances on a plain-HTTP LAN; on an HTTPS page the
  // browser blocks mixed content regardless, so listing it costs nothing there.
  const connectSrc = ["'self'", 'https:', 'http:', 'wss:', 'ws:', 'blob:', 'data:'];
  if (livekit && !connectSrc.includes(livekit)) {
    connectSrc.push(livekit);
  }

  return {
    'default-src': ["'self'"],
    // 'wasm-unsafe-eval' is required by the rnnoise WebAssembly module the
    // noise suppressor instantiates (web/src/audio/AudioManager.ts). It permits
    // WebAssembly compilation only and does not re-enable eval() or
    // new Function(), which is why it exists as a separate source expression.
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    // React writes element styles through the CSSOM rather than as inline style
    // attributes, so `style={{...}}` is unaffected by CSP. 'unsafe-inline' is
    // here for injected <style> blocks from the bundler and from third-party
    // components, and carries far less risk than its script-src namesake.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'media-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': connectSrc,
    // The 15-second WebSocket keepalive runs in a Worker created from a blob
    // URL (web/src/hooks/useWebSocket.ts). worker-src falls back to script-src,
    // so omitting blob: here kills every connection's heartbeat silently.
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': [...EMBED_FRAME_ORIGINS],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // The app is never framed. The desktop client loads instances with a
    // top-level BrowserWindow.loadURL (desktop/src/main.ts:380), not a webview
    // or an iframe, so denying all ancestors does not affect it.
    'frame-ancestors': ["'none'"],
    'report-uri': [CSP_REPORT_PATH],
    'report-to': [CSP_REPORT_GROUP],
  };
}

export function buildCspHeaderValue(input: CspInput): string {
  return Object.entries(buildCspDirectives(input))
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/server && npx vitest run src/utils/csp.test.ts`
Expected: 14 passed.

- [x] **Step 5: Prove the two non-obvious assertions can fail**

Temporarily delete `'wasm-unsafe-eval'` from `script-src` and `'blob:'` from
`worker-src`, re-run, and confirm those two tests go red. Restore. Record the
observed failure messages in the task report. If either still passes, the test
is not asserting what it claims.

- [x] **Step 6: Commit**

```bash
git add packages/server/src/utils/csp.ts packages/server/src/utils/csp.test.ts
git commit -m "feat(server): build the content security policy from instance config

The LiveKit signalling origin is operator configuration, so the policy cannot
be a build-time constant. Keeps script-src, object-src, base-uri, form-action
and frame-ancestors tight and leaves the content origins broad, which is the
only workable shape for an app that renders arbitrary linked content and
federates with instances it learns about at runtime.

Not yet wired into the server."
```

---

## Task 3: The violation sink

Reports are useless if the endpoint silently rejects them. Browsers post CSP
reports as `application/csp-report` and Reporting API payloads as
`application/reports+json`; Fastify knows neither and answers 415, which would
produce an empty report log that reads exactly like a clean policy.

**Files:**
- Create: `packages/server/src/routes/cspReport.ts`
- Test: `packages/server/src/routes/cspReport.test.ts`

**Interfaces:**
- Consumes: `CSP_REPORT_PATH` from `../utils/csp.js`.
- Produces: `export async function cspReportRoutes(app: FastifyInstance): Promise<void>`,
  registered by Task 4.

- [x] **Step 1: Write the failing test**

Create `packages/server/src/routes/cspReport.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { cspReportRoutes } from './cspReport.js';

describe('POST /api/csp-report', () => {
  let app: FastifyInstance;
  let warned: unknown[][];

  beforeEach(async () => {
    warned = [];
    app = Fastify();
    app.log.warn = ((...args: unknown[]) => { warned.push(args); }) as never;
    await app.register(cspReportRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('accepts the application/csp-report content type browsers actually send', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://nova.example/app',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.example/x.js',
        },
      }),
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
    expect(JSON.stringify(warned[0])).toContain('script-src');
  });

  it('accepts the Reporting API content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([
        {
          type: 'csp-violation',
          url: 'https://nova.example/app',
          body: { effectiveDirective: 'worker-src', blockedURL: 'blob:https://nova.example/abc' },
        },
      ]),
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
    expect(JSON.stringify(warned[0])).toContain('worker-src');
  });

  it('accepts plain application/json too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }),
    });
    expect(res.statusCode).toBe(204);
  });

  it('does not fall over on a malformed body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: 'this is not json',
    });
    expect(res.statusCode).toBe(204);
    expect(warned.length).toBe(1);
  });

  it('truncates an oversized report instead of logging it whole', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({
        'csp-report': { 'blocked-uri': `https://evil.example/${'a'.repeat(20_000)}` },
      }),
    });
    expect(res.statusCode).toBe(204);
    const logged = JSON.stringify(warned[0]);
    expect(logged.length).toBeLessThan(6_000);
  });

  it('requires no authentication, because a violation can happen pre-login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({ 'csp-report': {} }),
    });
    expect(res.statusCode).toBe(204);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx vitest run src/routes/cspReport.test.ts`
Expected: FAIL, `Cannot find module './cspReport.js'`.

- [x] **Step 3: Write the implementation**

Create `packages/server/src/routes/cspReport.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { CSP_REPORT_PATH } from '../utils/csp.js';

/**
 * Largest report body accepted. Reports are diagnostics from untrusted browsers
 * and a violation can be triggered deliberately, so the endpoint must not become
 * a way to write unbounded data into an operator's log.
 */
const MAX_REPORT_BYTES = 16_384;

/** Longest string written to the log for a single report. */
const MAX_LOGGED_CHARS = 4_096;

/**
 * The violation sink for `report-uri` and `report-to`.
 *
 * Unauthenticated on purpose: a policy violation can happen on the login screen,
 * before any token exists, and those are exactly the reports worth having. It
 * answers 204 to everything, including malformed input, because a browser has no
 * use for an error and retrying would only amplify.
 *
 * The content-type parsers are the point of this file. Browsers post CSP reports
 * as `application/csp-report` and Reporting API payloads as
 * `application/reports+json`. Fastify ships parsers for neither and would answer
 * 415, producing an empty log that is indistinguishable from a clean policy.
 */
export async function cspReportRoutes(app: FastifyInstance): Promise<void> {
  const parseAsText = (
    _req: unknown,
    payload: NodeJS.ReadableStream,
    done: (err: Error | null, body?: string) => void,
  ): void => {
    let raw = '';
    let truncated = false;
    payload.on('data', (chunk: Buffer | string) => {
      if (truncated) return;
      raw += chunk.toString();
      if (raw.length > MAX_REPORT_BYTES) {
        raw = raw.slice(0, MAX_REPORT_BYTES);
        truncated = true;
      }
    });
    payload.on('end', () => done(null, raw));
    payload.on('error', () => done(null, ''));
  };

  for (const contentType of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(contentType, { parseAs: undefined as never }, parseAsText as never);
  }

  app.post(CSP_REPORT_PATH, async (request, reply) => {
    const body = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body ?? {});

    let summary: string;
    try {
      const parsed: unknown = JSON.parse(body);
      summary = JSON.stringify(parsed);
    } catch {
      summary = `unparseable: ${body}`;
    }

    request.log.warn(
      { csp: summary.slice(0, MAX_LOGGED_CHARS), userAgent: request.headers['user-agent'] },
      'CSP violation reported',
    );

    return reply.code(204).send();
  });
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/server && npx vitest run src/routes/cspReport.test.ts`
Expected: 6 passed.

If the `addContentTypeParser` call signature is rejected at runtime, use the
documented Fastify 4 form and adjust the code, not the test:
`app.addContentTypeParser(contentType, { parseAs: 'string' }, (req, body, done) => done(null, body))`.
Confirm whichever form you use against a real inject, not against types alone.

- [x] **Step 5: Prove the content-type test can fail**

Temporarily remove the `application/csp-report` parser registration and confirm
that test goes red with a 415. This is the assertion the whole rollout depends
on: a silently-415ing sink would make an unvalidated policy look validated.
Restore and record the observed status code in the task report.

- [x] **Step 6: Commit**

```bash
git add packages/server/src/routes/cspReport.ts packages/server/src/routes/cspReport.test.ts
git commit -m "feat(server): add the policy violation report endpoint

Registers parsers for application/csp-report and application/reports+json.
Fastify has neither, so without them the endpoint answers 415 and the report
log stays empty in a way that looks exactly like a clean policy.

Not yet wired into the server."
```

---

## Task 4: Wire the headers into the server

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/test/http-security-headers.test.ts` (create)

**Interfaces:**
- Consumes: `buildCspHeaderValue`, `CSP_REPORT_GROUP`, `CSP_REPORT_PATH` from
  `./utils/csp.js`; `cspReportRoutes` from `./routes/cspReport.js`.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Add the dependency**

```bash
cd /Users/jbraun/backspace-public
pnpm --filter @backspace/server add @fastify/helmet@^11.1.1
```

Then confirm the resolved tree is the Fastify 4 line, not a Fastify 5 one:

Run: `cd packages/server && node -e "console.log(require('./node_modules/@fastify/helmet/package.json').version, require('./node_modules/@fastify/helmet/package.json').dependencies['fastify-plugin'])"`
Expected: a `11.x` version and `^4.x`. If it prints `^5` or `^6`, the wrong
major was installed. Stop and correct it.

- [x] **Step 2: Write the failing test**

Create `packages/server/test/http-security-headers.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTwoInstances, type TwoInstanceHarness } from './helpers/twoInstanceHarness.js';

/** Split a CSP header value into directive name -> source list. */
function parsePolicy(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const segment of header.split(';')) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out[parts[0]!] = parts.slice(1);
  }
  return out;
}

describe('HTTP security headers, LiveKit unconfigured', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstances();
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('ships the policy report-only, so nothing is blocked yet', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('carries the directives that stop injection and framing', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const p = parsePolicy(res.headers.get('content-security-policy-report-only') ?? '');
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['frame-ancestors']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'self'"]);
    expect(p['script-src']).not.toContain("'unsafe-inline'");
    expect(p['worker-src']).toContain('blob:');
  });

  it('names no LiveKit origin when voice is off', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const header = res.headers.get('content-security-policy-report-only') ?? '';
    expect(header).not.toContain('livekit.test.local');
  });

  it('declares the reporting endpoint group', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('reporting-endpoints') ?? '').toContain('/api/csp-report');
  });

  it('sets nosniff and a referrer policy', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBeTruthy();
  });

  it('leaves HSTS to the TLS terminator', async () => {
    // Caddy owns Strict-Transport-Security because only the terminator knows
    // TLS is actually in play. Emitting it from the app would be wrong on a
    // plain-HTTP LAN deployment and would double up behind Caddy.
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('allows cross-origin resource loading, which federation depends on', async () => {
    // Peers load avatars and attachments from each other with plain <img>.
    // helmet's default Cross-Origin-Resource-Policy of same-origin would
    // block every one of them.
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('does not override a route that already set its own stricter policy', async () => {
    // routes/uploads.ts serves user files under a `default-src 'none'` sandbox.
    // That policy is stricter than the app policy and must survive, and the
    // permissive report-only header must not be attached alongside it.
    const res = await fetch(`${h.home.origin}/api/uploads/does-not-exist.png`);
    const enforced = res.headers.get('content-security-policy');
    if (enforced !== null) {
      expect(enforced).toContain("default-src 'none'");
      expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    }
  });

  it('accepts a violation report over the wire', async () => {
    const res = await fetch(`${h.home.origin}/api/csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }),
    });
    expect(res.status).toBe(204);
  });
});

describe('HTTP security headers, LiveKit configured', () => {
  let h: TwoInstanceHarness;

  beforeAll(async () => {
    h = await bootTwoInstances({ enableLiveKit: true });
  }, 120_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it('names the configured LiveKit origin in connect-src', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    const p = parsePolicy(res.headers.get('content-security-policy-report-only') ?? '');
    expect(p['connect-src']).toContain('wss://livekit.test.local');
  });
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `cd packages/server && npx vitest run test/http-security-headers.test.ts`
Expected: FAIL on every header assertion, since no header is set yet.

- [x] **Step 4: Wire it up**

In `packages/server/src/index.ts`, add to the imports:

```ts
import helmet from '@fastify/helmet';
import { buildCspHeaderValue, CSP_REPORT_GROUP, CSP_REPORT_PATH } from './utils/csp.js';
import { cspReportRoutes } from './routes/cspReport.js';
```

Immediately after the `await app.register(cors, {...});` block, insert:

```ts
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
  // Report-only for now. Flipping this to `Content-Security-Policy` is a
  // separate, deliberate change gated on a clean report log from real
  // deployments. See docs/systems/web-security.md, "Rollout".
  const cspHeaderName = 'Content-Security-Policy-Report-Only';
  const reportingEndpoints = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

  app.addHook('onSend', async (request, reply, payload) => {
    // A route that has already set an enforcing policy is asserting something
    // stricter about its own response than the app policy can. routes/uploads.ts
    // sandboxes served user files under `default-src 'none'`, and attaching a
    // permissive report-only policy next to it would only produce noise in the
    // sink from responses that are already locked down.
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header(cspHeaderName, cspHeaderValue);
      reply.header('Reporting-Endpoints', reportingEndpoints);
    }
    return payload;
  });

  await app.register(cspReportRoutes);
```

`config` is already imported at the top of the file.

- [x] **Step 5: Run the test to verify it passes**

Run: `cd packages/server && npx vitest run test/http-security-headers.test.ts`
Expected: 10 passed.

- [x] **Step 6: Prove the LiveKit assertion is not vacuous**

Temporarily change `buildCspHeaderValue({ livekitUrl: config.livekit.url })` to
`buildCspHeaderValue({})` and confirm the "names the configured LiveKit origin"
test goes red. Restore. This is the one assertion that proves the policy is
actually built from config rather than from a constant, so it must be shown to
fail. Record the failure output in the task report.

- [x] **Step 7: Run everything**

```bash
cd packages/server && npx vitest run && npx tsc --noEmit && pnpm typecheck:e2e
```
Expected: the full suite green, both typechecks exit 0.

Pay attention to the federation e2e suites here. They assert on real HTTP
responses between instances, so a header change that broke S2S would surface
there. S2S requests carry no browser `Origin` and authenticate by HMAC, so they
should be unaffected; confirm that rather than assume it.

- [x] **Step 8: Commit**

```bash
git add packages/server/package.json packages/server/src/index.ts \
        packages/server/test/http-security-headers.test.ts ../../pnpm-lock.yaml
git commit -m "feat(server): send security headers and the policy in report-only mode

helmet covers the static headers with two deliberate departures from its
defaults: HSTS is left to the TLS terminator, and Cross-Origin-Resource-Policy
is cross-origin because federated avatars and attachments load across origins.

The policy itself is applied by a hook rather than by helmet so it can be built
from runtime config and can stand aside for routes that set a stricter one of
their own, which the file-serving route does."
```

---

## Task 5: Meta policy in the built page

Defence in depth for the case where a response reaches a browser without the
server's header, which is what happens when the SPA is served by something other
than the Fastify static handler.

**Files:**
- Modify: `packages/web/index.html`
- Test: `packages/web/src/index-html.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [x] **Step 1: Write the failing test**

Create `packages/web/src/index-html.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

describe('index.html meta policy', () => {
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i,
  );

  it('declares a meta policy', () => {
    expect(meta).not.toBeNull();
  });

  it('constrains scripts, objects and base', () => {
    const content = meta?.[1] ?? '';
    expect(content).toContain("object-src 'none'");
    expect(content).toContain("base-uri 'self'");
    expect(content).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('carries no directive the server owns dynamically', () => {
    // connect-src, img-src and frame-src depend on operator config and on peers
    // discovered at runtime. A meta tag cannot know them, and a meta policy
    // INTERSECTS with the header rather than replacing it, so a stale copy here
    // would silently block things the server policy allows.
    const content = meta?.[1] ?? '';
    for (const directive of ['connect-src', 'img-src', 'media-src', 'frame-src']) {
      expect(content).not.toContain(directive);
    }
  });

  it('carries no directive a meta tag cannot express', () => {
    // frame-ancestors, report-uri and sandbox are ignored in a meta policy.
    // Putting them here would read as protection that is not there.
    const content = meta?.[1] ?? '';
    for (const directive of ['frame-ancestors', 'report-uri', 'sandbox']) {
      expect(content).not.toContain(directive);
    }
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/web && npx vitest run src/index-html.test.ts`
Expected: FAIL on "declares a meta policy". There is no meta tag yet.

- [x] **Step 3: Add the tag**

In `packages/web/index.html`, immediately after the `<meta name="viewport" ...>`
line, add:

```html
    <!-- Defence in depth only. The server sends the full policy as a header,
         built from instance config (see docs/systems/web-security.md). A meta
         policy INTERSECTS with the header rather than replacing it, so this
         carries only the directives that never depend on runtime config.
         Adding connect-src, img-src or frame-src here would silently block
         whatever the server policy allows and this copy has gone stale on. -->
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self'" />
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/web && npx vitest run src/index-html.test.ts`
Expected: 4 passed.

- [x] **Step 5: Confirm the built app actually runs under it**

```bash
cd packages/web && npx vite build && npx vite preview --port 4173
```

Open `http://localhost:4173` and check the browser console. Expected: the app
shell renders and there is **no** `Refused to load` or `Refused to execute`
message. Vite emits the bundle as a module script with a `src`, so `'self'`
covers it. If a CSP error appears, the meta policy is wrong and must be fixed
here rather than loosened in the server policy. Record what the console showed.

- [x] **Step 6: Run the web suite and build**

```bash
cd packages/web && npx vitest run && npx tsc --noEmit && npx vite build
```
Expected: 492 passed, both exit 0.

- [x] **Step 7: Commit**

```bash
git add packages/web/index.html packages/web/src/index-html.test.ts
git commit -m "feat(web): add a static policy to the page as defence in depth

Script, object and base directives only. A meta policy intersects with the
header rather than replacing it, so anything that depends on runtime config
stays out of here."
```

---

## Task 6: Transport headers in Caddy

**Files:**
- Modify: `Caddyfile`
- Test: manual, plus `actionlint` is not applicable here. Verified by `caddy validate`.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [x] **Step 1: Add the header block**

Replace the contents of `Caddyfile` with:

```
# Backspace — Caddy reverse proxy configuration
# DOMAIN is read from the container environment (set via docker-compose.yml)

{$DOMAIN} {
    # Security header ownership, so the two layers never fight:
    #
    #   Caddy owns Strict-Transport-Security. Only the TLS terminator knows
    #   HTTPS is genuinely in play, and an app that emitted HSTS would be wrong
    #   on a plain-HTTP LAN deployment.
    #
    #   The app owns everything else, including the Content Security Policy,
    #   which it builds from instance config at boot. Do not set a CSP here:
    #   two policies on one response intersect, and a static copy in this file
    #   would go stale against the dynamic one and block voice or embeds.
    #
    # See docs/systems/web-security.md.
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }

    # LiveKit signaling — strip /livekit prefix, forward to host-mode LiveKit
    handle_path /livekit/* {
        reverse_proxy host.docker.internal:7880
    }

    # Backspace API, WebSocket, and frontend — Docker DNS resolves "backspace"
    reverse_proxy backspace:3000
}
```

- [x] **Step 2: Validate the syntax**

Run: `docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e DOMAIN=example.test caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
Expected: `Valid configuration`.

If Docker is unavailable, run `caddy validate` against a local Caddy binary. Do
not skip this step: a malformed Caddyfile takes the whole deployment down on the
next restart, and nothing else in CI parses this file.

- [x] **Step 3: Note the deliberate omission**

`preload` is **not** included in the HSTS value. Submitting a domain to the
preload list is effectively irreversible and is the operator's decision, not a
default this project gets to make on their behalf. Do not add it.

- [x] **Step 4: Commit**

```bash
git add Caddyfile
git commit -m "feat(deploy): set HSTS at the reverse proxy

Records the split in a comment: the proxy owns transport security because only
it knows TLS is in play, and the app owns the content policy because it builds
it from instance config."
```

---

## Task 7: Documentation

Sequenced after the implementation so the prose describes what exists.

**Files:**
- Create: `docs/systems/web-security.md`
- Modify: `docs/systems/api.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

- [x] **Step 1: Write the subsystem doc**

Create `docs/systems/web-security.md` covering, in this order:

1. **What the policy is for.** The app renders arbitrary user content and
   federates with instances discovered at runtime, so `img-src`, `media-src` and
   `connect-src` cannot be constrained. The directives doing real work are
   `script-src`, `object-src`, `base-uri`, `form-action` and `frame-ancestors`.
   State this as a trade, not as a limitation to be fixed later.
2. **Where the policy comes from.** `packages/server/src/utils/csp.ts`, built at
   boot from `config.livekit.url`. Applied by the `onSend` hook in `index.ts`,
   not by helmet.
3. **The three non-obvious directives**, each with the code that requires it:
   - `worker-src blob:` for the WebSocket heartbeat worker
     (`packages/web/src/hooks/useWebSocket.ts:90`).
   - `script-src 'wasm-unsafe-eval'` for rnnoise
     (`packages/web/src/audio/AudioManager.ts:399`).
   - `frame-src` listing the three embed origins produced by
     `packages/server/src/utils/embedClassifier.ts`.
4. **Route-level override.** `routes/uploads.ts` serves user files under a
   stricter `default-src 'none'` policy, and the hook stands aside for any
   response that already carries an enforcing `Content-Security-Policy`.
5. **Header ownership.** A table: Caddy owns HSTS; the app owns CSP,
   `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`,
   `Cross-Origin-Opener-Policy`, `X-Frame-Options`. State that CORP is
   `cross-origin` deliberately, because federated avatars and attachments load
   across origins and helmet's `same-origin` default blocks them.
6. **The CORS posture**, at length. This is the part most likely to be
   "corrected" by a future reader who has not checked the code, so it needs the
   full argument: the reflected origin is required by client federation, it is
   safe only because there is no ambient credential, and
   `test/cors-posture.test.ts` fails if that stops being true. Name the ordering
   in `instanceStore.connectToRemote` explicitly.
7. **Rollout.** State plainly that the policy currently ships **report-only** and
   therefore blocks nothing. Give the exact conditions for the flip, from Task 8.
8. **The meta policy** in `packages/web/index.html`: what it carries, and why it
   must not carry connect/img/frame or frame-ancestors/report-uri.

- [x] **Step 2: Add the API row**

In `docs/systems/api.md`, add `POST /api/csp-report` to the appropriate section:
unauthenticated, accepts `application/csp-report`, `application/reports+json` and
`application/json`, answers 204 to everything including malformed bodies, logs at
warn level.

- [x] **Step 3: Add the CLAUDE.md row**

In the subsystem documentation table in `CLAUDE.md`, add, keeping the existing
column format:

```
| [web-security.md](docs/systems/web-security.md) | Content Security Policy construction and rollout state, the CORS posture and why the origin is reflected, security-header ownership between Caddy and the app, the route-level policy override for served files | Any CSP, CORS or security-header work; before "tightening" CORS |
```

- [x] **Step 4: Check the doc against the code**

Open each file the doc names and confirm the line references still resolve.
Every one of them was accurate on 2026-09-02; if the implementation moved during
this plan, fix the doc, not the reference.

- [x] **Step 5: Commit**

```bash
git add docs/systems/web-security.md docs/systems/api.md CLAUDE.md
git commit -m "docs: describe the content policy, CORS posture and header ownership"
```

---

## Task 8 (GATED): Flip the policy to enforcing

**Do not run this task as part of the initial pass.** It is written here so the
work is not lost, and so the conditions are recorded rather than remembered.

**Precondition, all of which must hold:**

1. Tasks 1-7 are merged and released.
2. The report-only policy has run on at least two real deployments for a period
   covering ordinary use: sending messages, a link embed rendering, a file
   upload, a cross-instance federated conversation, and a **real voice join with
   screen share**. The voice path is the one most likely to violate, since
   LiveKit brings its own workers and WASM.
3. `grep 'CSP violation reported' <instance log>` is empty on every instance
   across that period, or every violation found has been resolved by an explicit
   change to `utils/csp.ts` and the clock restarted.

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/test/http-security-headers.test.ts`
- Modify: `docs/systems/web-security.md`

- [ ] **Step 1: Record the evidence first**

Write into `docs/systems/web-security.md` under "Rollout" which instances ran
the report-only policy, over what period, which flows were exercised, and what
the report log contained. An empty log with no record of what was exercised is
not evidence, it is an absence of data. This project has produced seven separate
cases of recorded success without evidence; do not add an eighth.

- [ ] **Step 2: Invert the test first**

In `packages/server/test/http-security-headers.test.ts`, change the first test to:

```ts
  it('enforces the policy', async () => {
    const res = await fetch(`${h.home.origin}/api/instance/info`);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });
```

and update every other `content-security-policy-report-only` lookup in the file
to `content-security-policy`.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/server && npx vitest run test/http-security-headers.test.ts`
Expected: FAIL. The header is still report-only.

- [ ] **Step 4: Flip the header name**

In `packages/server/src/index.ts`:

```ts
  const cspHeaderName = 'Content-Security-Policy';
```

The `Reporting-Endpoints` header and the sink stay. An enforcing policy still
reports, and those reports are now the only signal that the flip broke something
for a user whose flow nobody exercised.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/server && npx vitest run test/http-security-headers.test.ts`
Expected: all pass.

- [ ] **Step 6: Exercise the real flows once more against the enforcing build**

Deploy to the throwaway staging VM (memory `kobold-test-vm` has the host) and repeat the same
list from the precondition, watching the browser console for `Refused to`
messages. A violation that was reported and ignored under report-only becomes a
broken feature here.

- [ ] **Step 7: Update the doc and commit**

```bash
git add packages/server/src/index.ts packages/server/test/http-security-headers.test.ts \
        docs/systems/web-security.md
git commit -m "security(server): enforce the content security policy

Report-only ran on <instances> from <date> to <date> across chat, embeds,
uploads, cross-instance conversation and a voice join with screen share, with
<n> violations, all resolved. The reporting endpoint stays in place."
```

---

## Self-review notes

Checked against §WS3 on 2026-09-02.

**Covered:** helmet added; CSP built at runtime from `config.livekit.url`;
`frame-src` provider allowlist; `index.html` meta CSP restricted to
script/object/base; Caddyfile ownership split documented; CORS at
`index.ts:46-48` addressed; report-only before enforcing; S2S confirmed
unaffected via the existing federation e2e suites.

**Deliberately not done, with reasons in "Corrections to the spec" above:** the
registry-backed CORS callback, and the two-instance plus LiveKit Docker rig.
Track E must not assume the rig exists.

**Deliberately out of scope:** the CORS "log-and-allow observation phase" the
spec asks for. It exists to de-risk a switch to rejecting origins, and this plan
does not make that switch, so the phase would observe a decision that is never
taken.

**Two things this plan found and does not fix**, both recorded for the master
plan's follow-up list rather than smuggled in here:
- `packages/web/package.json:15` declares an `e2e:identity-deletion` script that
  runs `playwright test e2e/identity-deletion.spec.ts`. Playwright is not in any
  dependency list, there is no config file, and `packages/web/e2e/` does not
  exist. The script is dead.
- `docs/systems/uploads.md` should mention that served files carry their own
  sandbox policy and that the app policy stands aside for them. Small, and it
  belongs to Task 7's doc pass only if the reviewer wants it there.
