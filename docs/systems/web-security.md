# Web Security (CSP, CORS, security headers)

Source files:
- `packages/server/src/utils/csp.ts` - pure policy builder. Turns instance config into a directive map and a header string. No Fastify imports, no I/O.
- `packages/server/src/routes/cspReport.ts` - the violation sink, plus the two content-type parsers browsers use to post reports.
- `packages/server/src/index.ts` - CORS registration (line 65), helmet registration (line 104), the `onSend` hook that attaches the policy (line 129), and the sink registration (line 202).
- `packages/server/src/routes/uploads.ts:49` - the one route that sets its own, stricter policy.
- `packages/web/index.html` - the static meta policy.
- `Caddyfile` - the reverse proxy, which owns HSTS.
- `packages/server/test/http-security-headers.test.ts`, `packages/server/test/cors-posture.test.ts` - live-server assertions against spawned instances.
- `packages/server/src/utils/csp.test.ts`, `packages/server/src/routes/cspReport.test.ts` - unit tests.

> **Current state: report-only.** The server sends the policy as
> `Content-Security-Policy-Report-Only`. It blocks nothing. A browser evaluates
> it, posts violations to the sink, and loads the resource anyway. Read
> "Rollout" below before assuming any of this stops an attack today. The one
> exception is the meta tag in `packages/web/index.html`, which is an enforcing
> policy and does block. See "The meta policy".

---

## 1. What the policy is for

Backspace renders arbitrary user content and federates with instances it
discovers at runtime. A message can carry a link to any site on the web, and the
embed pipeline pulls that site's preview image. A user can connect to a peer
instance whose origin nobody knew about at build time. So `img-src`, `media-src`
and `connect-src` cannot be constrained to a host list without breaking the
product. They list schemes instead of hosts.

That is a trade, not a gap waiting to be closed. Do not open a task to "tighten
img-src". The directives that carry the weight here are the ones that stop
script injection and clickjacking, and those are tight:

| Directive | Value | What it buys |
|---|---|---|
| `script-src` | `'self' 'wasm-unsafe-eval'` | No inline script, no `eval`, no third-party script host. This is the one that matters. |
| `object-src` | `'none'` | No plugin content. |
| `base-uri` | `'self'` | An injected `<base>` cannot repoint every relative URL on the page. |
| `form-action` | `'self'` | An injected form cannot post to an attacker's origin. |
| `frame-ancestors` | `'none'` | The app is never framed, so clickjacking has nothing to work with. Header-only; see "The meta policy". |

## 2. Where the policy comes from

`utils/csp.ts` exports `buildCspDirectives()` and `buildCspHeaderValue()`. They
are pure. They take a `CspInput` rather than importing `config`, so the tests
drive them directly.

`index.ts` calls `buildCspHeaderValue({ livekitUrl: config.livekit.url })` once
at boot and keeps the string. Config does not change while the process runs.

The policy is built at runtime rather than written as a constant because of one
directive. `connect-src` lists the `wss:` scheme, which covers a
TLS-terminated LiveKit, but an operator running LiveKit unencrypted on a LAN
needs their exact `ws://host:port` listed and no build-time string can know it.
`livekitOrigin()` parses `config.livekit.url`, accepts only `ws:`, `wss:`,
`http:` and `https:`, and normalises to the origin so a configured
`wss://host/livekit/` is emitted as `wss://host`. An absent, empty or
unparseable value adds nothing.

The header is attached by the `onSend` hook in `index.ts`, not by helmet.
helmet is registered with `contentSecurityPolicy: false` on purpose, so the
policy exists in exactly one place and can be built from config and can stand
aside for the route that sets its own.

The full value with voice unconfigured:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https: http: wss: ws: blob: data:; worker-src 'self' blob:; child-src 'self' blob:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; report-uri /api/csp-report; report-to csp
```

With `LIVEKIT_URL=wss://voice.example.org/livekit/` set, the only difference is
`wss://voice.example.org` appended to `connect-src`.

## 3. The non-obvious directives

Each of these exists because a specific piece of code needs it. Removing one
does not produce an error at the removal site. It produces a silently broken
feature somewhere else, so the code is named here.

**`worker-src 'self' blob:`** - `packages/web/src/hooks/useWebSocket.ts:78-90`.
`createHeartbeatWorker()` builds a `Blob` of worker source and calls
`new Worker(URL.createObjectURL(blob))`. That worker runs the 15 second
WebSocket keepalive. `worker-src` falls back to `script-src` when absent, and
`script-src` has no `blob:`, so omitting this kills every connection's
heartbeat with nothing but a console entry to show for it.

**`script-src 'wasm-unsafe-eval'`** - `packages/web/src/audio/AudioManager.ts:399`.
`loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath })`
instantiates the RNNoise WebAssembly module for noise suppression. Without the
directive, noise suppression fails to initialise. `'wasm-unsafe-eval'` permits
WebAssembly compilation only. It does not re-enable `eval()` or
`new Function()`, which is why it exists as a separate source expression rather
than being folded into `'unsafe-eval'`.

**`frame-src` listing three origins** - `packages/server/src/utils/embedClassifier.ts`
produces `embedUrl` values on exactly three hosts:
`https://www.youtube-nocookie.com` (line 73), `https://player.vimeo.com`
(line 86) and `https://open.spotify.com` (line 100). `frame-src` falls back to
`default-src`, which is `'self'`, so without this list the YouTube, Vimeo and
Spotify embeds render as blank boxes. The list is exported as
`EMBED_FRAME_ORIGINS` from `csp.ts` and a unit test asserts it matches
`frame-src` exactly. If a fourth provider is added to `embedClassifier.ts`, it
has to be added here too.

**`style-src 'unsafe-inline'`** is a deliberate looseness worth naming so nobody
mistakes it for an oversight. React writes element styles through the CSSOM
rather than as inline `style` attributes, so `style={{...}}` is unaffected by
CSP either way. The directive is here for injected `<style>` blocks from the
bundler and from third-party components. Inline style carries far less risk
than its `script-src` namesake, which stays clean.

## 4. Route-level override

`routes/uploads.ts:49` serves user-uploaded files under its own enforcing
policy:

```
default-src 'none'; style-src 'unsafe-inline'; img-src 'self'
```

That is stricter than the app policy and it must survive. The `onSend` hook in
`index.ts` therefore checks `reply.getHeader('Content-Security-Policy')` and
does nothing when a route has already set one. Attaching a permissive
report-only policy alongside a sandbox would only fill the sink with reports
from responses that are already locked down.

Verified by observed headers, not assumed. A request for a file that exists
returns `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'`
and no report-only header. An ordinary route returns the full report-only
policy and no enforcing one. Both are asserted in
`test/http-security-headers.test.ts`, along with the case that catches the
obvious mistake: the 404 path in `uploads.ts` returns before the header is set,
so a missing file must still get the app policy. A test that requested a
nonexistent file would assert nothing about the override.

The rule for any future route: if you set an enforcing
`Content-Security-Policy` on a response, you own that response's policy
completely. The app policy will not be merged in.

## 5. Header ownership

| Header | Owner | Value | Note |
|---|---|---|---|
| `Content-Security-Policy-Report-Only` | app (`onSend` hook) | built at boot | Report-only. See "Rollout". |
| `Reporting-Endpoints` | app (`onSend` hook) | `csp="/api/csp-report"` | Attached with the policy. |
| `Cross-Origin-Resource-Policy` | app (helmet) | `cross-origin` | Deliberate. See below. |
| `Cross-Origin-Opener-Policy` | app (helmet) | `same-origin` | |
| `Cross-Origin-Embedder-Policy` | app (helmet) | not sent | Disabled. It would require CORP headers on every third-party image an embed pulls in, which this app does not control. |
| `Referrer-Policy` | app (helmet) | `strict-origin-when-cross-origin` | |
| `X-Content-Type-Options` | app (helmet) | `nosniff` | |
| `X-Frame-Options` | app (helmet) | `DENY` | Belt and braces with `frame-ancestors 'none'`. |
| `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection` | app (helmet) | helmet 11 defaults, unchanged | |
| `Strict-Transport-Security` | Caddy | `max-age=31536000; includeSubDomains` | The app never sends it. |
| `Access-Control-*` | app (`@fastify/cors`) | see section 6 | |

**CORP is `cross-origin` on purpose.** helmet's default is `same-origin`.
Federation loads avatars and attachments from peer instances with plain `<img>`
and `<video>` tags, and `same-origin` blocks every one of them. This is not a
knob to turn back.

**HSTS belongs to the TLS terminator.** Only the terminator knows HTTPS is
genuinely in play. An app that emitted HSTS would be wrong on a plain-HTTP LAN
deployment and would double the header behind Caddy. `preload` is deliberately
absent from the value: submitting a domain to the preload list is effectively
irreversible and is the operator's decision, not a default this project makes
on their behalf.

**Proxy and tunnel mode ships no HSTS from this repo.**
`docker-compose.proxy.yml` parks Caddy in a profile that is never activated and
publishes the app on `127.0.0.1:${APP_PORT}` for an operator's own reverse
proxy or tunnel daemon. In that mode nothing in this repository sets
`Strict-Transport-Security`, because the app deliberately does not emit it and
the bundled Caddy is not running. That is consistent with the ownership split,
but it means an operator in Mode 2 or Mode 3 has to set HSTS on their own proxy
or accept that the deployment has none.

**Do not put a CSP in the Caddyfile.** Two policies on one response intersect
rather than replace. A static copy in that file would drift against the one
built from config and would start blocking voice or embeds on a deployment
whose LiveKit origin it never knew about.

## 6. The CORS posture

This section exists because the posture looks wrong at a glance and is the part
of this document most likely to be "corrected" by a reader who has not checked
the code. Read all of it before changing `@fastify/cors` options.

**What ships.** `index.ts:65` registers `@fastify/cors` with `origin: true`,
which reflects whatever `Origin` the request carried, including `null`.
`credentials` is not set, so `Access-Control-Allow-Credentials` is never sent.
`allowedHeaders` and `exposedHeaders` carry the `Tus-*` and `Upload-*` headers
that federated resumable uploads need on a cross-origin preflight.

**Why the origin has to stay reflected.** Client federation has a browser on
instance A talk directly to instance B before any server-to-server peering
exists. The ordering, in `packages/web/src/stores/instanceStore.ts`:

1. `probeInstance` (line 348) calls `tempClient.instance.info()` (line 365) against B with an unauthenticated client, to show the user what they are about to join.
2. `connectToRemote` (line 370) builds a temp client for B and, for a remote target, calls `tempClient.auth.register()` (line 430) with the namespaced `username@homeinstance`, falling back to `tempClient.auth.login()` (line 453) if that account already exists. For a target that is the user's own home instance it calls `tempClient.auth.login()` directly (line 401).
3. It calls `tempClient.instance.info()` again (line 476) to finish building the connection record.
4. It opens the WebSocket to B with `connectInstance(origin, response.token)` (line 511).
5. Only after all of that does it call `api.federation.ensurePeered({ remoteOrigin: origin })` (line 518), and that call goes to the browser's own home server, not to B.

At the moment the browser registers and logs in against B, B has no peer row
for A. An origin allowlist backed by the peer registry rejects the entire
onboarding flow.

It is also not merely a startup race that settles. `ensurePeered` can return
`admin_required` or `rejected` (see `docs/systems/client-federation.md`,
"Peering-status taxonomy"). An admin can decline server-to-server peering
permanently while that browser connection is expected to keep working
indefinitely: the user stays logged in to B, reads channels and sends messages
there. There is no later point at which the registry becomes a correct source
of truth for which browsers may talk to this instance.

**Why reflecting is safe here.** A reflected origin is dangerous when it is
paired with an ambient credential, because the browser then attaches that
credential to a cross-origin request and the response is readable. This API has
no ambient credential to ride on:

- No cookies. There is no cookie plugin, no `setCookie`, no session middleware. Every occurrence of the word "cookie" under `packages/server/src` is either `youtube-nocookie.com` or a comment explaining this posture.
- No HTTP authentication.
- Auth is a bearer token read from `localStorage` (`packages/web/src/stores/authStore.ts:42`) and attached explicitly by our own client (`packages/web/src/api/client.ts:348`). No `fetch` in the web package sets a `credentials` mode.

A cross-origin page cannot obtain that token and the browser will not attach it
for the page. So restricting `Access-Control-Allow-Origin` would buy nothing and
would cost federation.

**What was removed.** `credentials: true` used to be set. It granted nothing,
because there was no credential to grant, and it was the half of the
reflected-origin pair that turns into a real vulnerability the day somebody adds
a cookie. It is gone.

**What fails if the premise stops holding.**
`packages/server/test/cors-posture.test.ts` greps `packages/server/src` for
`setCookie`, `@fastify/cookie`, `request.cookies` and the `set-cookie` header
name, and fails if any appears. It also asserts that
`Access-Control-Allow-Credentials` is absent on both a simple request and a
preflight, and that `index.ts` still contains the word "bearer" and does not
contain `credentials: true`. If that suite goes red because a cookie was
introduced, the fix is not to update the test. The whole posture in this
section has to be revisited first, because the reasoning above no longer holds.

## 7. Rollout

The policy ships as `Content-Security-Policy-Report-Only`. It blocks nothing
today. A browser evaluates it, posts a report to `/api/csp-report`, and loads
the resource anyway. Nobody should describe this as protecting the app until
the flip below has happened.

Violations land on `POST /api/csp-report`, which is unauthenticated on purpose,
because a violation can happen on the login screen before any token exists and
those are exactly the reports worth having. The route registers content-type
parsers for `application/csp-report` and `application/reports+json`. Fastify
ships parsers for neither and would answer 415, producing an empty report log
that is indistinguishable from a clean policy. It answers 204 to everything,
including malformed bodies, reads at most 16 KB off the wire and logs at most
4096 characters per report at warn level with the message
`CSP violation reported`.

**The sink is registered after `@fastify/rate-limit`, and the ordering is
load-bearing.** `@fastify/rate-limit` only covers routes registered after it.
An earlier version of this change registered `cspReportRoutes` next to the
`onSend` hook, which sits before the limiter, and the sink was exempt: 260
consecutive POSTs all returned 204 while an ordinary route returned 429 after
194. The sink is unauthenticated and writes a log line per report, so leaving it
uncovered is a way to fill an operator's disk. The registration therefore lives
down with the other route registrations in `index.ts`, with a comment saying
why. Do not tidy it back up next to the hook. A test in
`test/http-security-headers.test.ts` floods it and asserts that 429s appear.

**Conditions for flipping to enforcing.** All of these, not any of them:

1. The report-only policy has run on at least two real deployments for a period covering ordinary use: sending messages, a link embed rendering, a file upload, a cross-instance federated conversation, and a real voice join with screen share. The voice path is the one most likely to violate, because LiveKit brings its own workers and WebAssembly.
2. `grep 'CSP violation reported'` is empty in every instance log across that period, or every violation found has been resolved by an explicit change to `utils/csp.ts` and the clock restarted.
3. The evidence is written into this section first: which instances, over what period, which flows were exercised, what the log contained. An empty log with no record of what was exercised is not evidence of a clean policy. It is an absence of data.

The flip itself is one line in `index.ts`, changing `cspHeaderName` from
`Content-Security-Policy-Report-Only` to `Content-Security-Policy`, plus the
corresponding header names in `test/http-security-headers.test.ts`. The
`Reporting-Endpoints` header and the sink stay. An enforcing policy still
reports, and those reports become the only signal that the flip broke a flow
nobody exercised.

**Evidence log:** none yet. Report-only has not been deployed.

## 8. The meta policy

`packages/web/index.html` carries a `<meta http-equiv="Content-Security-Policy">`
tag:

```
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'
```

It is defence in depth for the case where a response reaches a browser without
the server's header, which is what happens when the SPA is served by something
other than the Fastify static handler.

**It enforces immediately.** There is no report-only form of a meta policy. So
while the server policy blocks nothing today, these four directives do block,
on every page load, in every deployment. Treat any change to this tag as a
change to enforced behaviour and load the built page in a real browser before
committing it.

**A meta policy intersects with the header rather than replacing it.** Both
apply, and a resource has to satisfy both. That is the whole reason this tag
carries so little:

- No `connect-src`, `img-src`, `media-src` or `frame-src`. They depend on operator config and on peers discovered at runtime. A meta tag cannot know them, and a stale copy here would silently block things the server policy allows.
- No `frame-ancestors`, `report-uri` or `sandbox`. A meta policy ignores all three. Putting them here would read as protection that is not there.
- No `child-src`. `frame-src` falls back to it, and the embed origins are server-owned config that must not appear in this file.

**`worker-src 'self' blob:` is in the tag even though the header carries it too,
and it has to be.** The plan for this work omitted it, and a real browser proved
the omission: `worker-src` falls back to `script-src` when absent, `script-src`
here has no `blob:`, and because the meta policy intersects with the header the
resulting page blocked the blob-URL heartbeat worker even though the server
policy allowed it. The block was silent apart from a console entry. This is the
concrete form of the intersection rule, and it is why anything added to this tag
must be checked against the header rather than reasoned about on its own.

`packages/web/src/index-html.test.ts` asserts the tag's contents and asserts
that none of the excluded directives appear in it.

### The dev server needs a relaxed copy of it

The tag enforces on the dev server too, and there the page is a different
shape. `@vitejs/plugin-react` injects its React Refresh preamble as an inline
`<script type="module">`. `script-src 'self' 'wasm-unsafe-eval'` has neither
`'unsafe-inline'` nor a nonce, so the browser blocks it, and every module the
plugin transforms carries a guard that throws
`@vitejs/plugin-react can't detect preamble` when it did not run. The result is
that `pnpm dev` serves a page that throws on first render, with the CSP
violation in the console as the only clue.

This shipped: the meta tag was verified in a headless browser against the
**built** bundle, which has no inline script and no preamble, so the check
passed and the dev path was never loaded.

`packages/web/src/build/devCsp.ts` fixes it with a `transformIndexHtml` plugin
that adds `'unsafe-inline'` to `script-src` for `vite dev` only. `apply: 'serve'`
keeps it out of the build, so the shipped artifact is unchanged, and
`order: 'pre'` puts it ahead of the plugins that inject scripts. The other three
directives stay on in dev, so a violation of `object-src`, `base-uri` or
`worker-src` still surfaces locally rather than in production.

**Any future directive added to this tag has to be checked on both paths.**
Building the page and loading the built page is not sufficient evidence; the dev
server renders different HTML.

---

## Dependency note

`@fastify/helmet` is pinned to `^11.1.1` and must stay on the 11.x line. The
12.x line depends on `fastify-plugin@^5` and 13.x on `^6`, and both target
Fastify 5. This repo is on Fastify 4 and every other plugin is pinned to its
Fastify 4 major (`@fastify/cors@^9`, `rate-limit@^9`, `static@^7`,
`websocket@^10`). A helmet bump is a Fastify 5 migration, not a version bump.
