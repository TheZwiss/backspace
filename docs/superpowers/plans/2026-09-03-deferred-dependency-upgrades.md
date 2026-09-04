# Deferred dependency upgrades: scope and cost

`osv-scanner.toml` defers 13 findings with `ignoreUntil = 2026-12-01`. When that
date passes they come back and block `main`. Ten of the thirteen are cleared by
five major upgrades. This document scopes those five so the order and the cost
can be decided before the deadline rather than under it.

Nothing here is a recommendation to start. No dependency version was changed and
no branch was created.

## Summary

| Package | Current | Target | Waivers cleared | Effort | Ships alone |
|---|---|---|---|---|---|
| `react-router-dom` | 6.30.6 | 7.18.3 | 2 | ~0.5 day | yes |
| `fastify` | 4.29.1 | 5.12.1 | 4 | 1-2 days | no, carries the plugins |
| `@fastify/static` | 7.0.4 | 10.1.3 | 2 | <1 hour on top of fastify 5 | no, needs fastify 5 |
| `find-my-way` | 8.2.2 | 9.9.0 (transitive) | 1 | zero | no, arrives with fastify 5 |
| `electron` | 40.10.6 | 43.x or 44.x, not 41 | 1 | 2-3 days | yes |

The remaining three waivers (`CVE-2021-23337`, `CVE-2025-13465` for lodash,
`GHSA-67mh-4wv8-2f99` for esbuild) are build-time only paths through
electron-builder and drizzle-kit. They are out of scope for this document.

One finding cuts across all five: **not one of the ten advisories is reachable
in this codebase as it is configured today.** That is stated per upgrade below
with the file path that makes it true. It does not make the upgrades optional,
because the scanner blocks on the version regardless, but it does mean none of
these is an incident and the order can be chosen on cost.

---

## 1. react-router-dom 6.30.6 to 7.18.3

### Driver

| Advisory | GHSA | Affected | Fixed | Reachable here |
|---|---|---|---|---|
| CVE-2026-53669 | GHSA-wrjc-x8rr-h8h6 | 6.0.0 - 7.17.0 | 7.18.0 | **Yes** |
| CVE-2026-53666 | GHSA-337j-9hxr-rhxg | 6.4.0 - 7.17.0 | 7.18.0 | No |

CVE-2026-53669 is an open redirect via backslashes in `<Link>` and
`useNavigate`, a follow-up to CVE-2025-68470. The SPA has 22 `<Link>` and 53
`useNavigate` call sites across `packages/web/src`, several of which take a
path derived from server data (`SpaceInviteCard.tsx`, `JoinPage.tsx`,
`deepLink.ts`). This is the only advisory of the ten with a real path to it in
the shipped product.

CVE-2026-53666 is arbitrary constructor injection through `deserializeErrors()`
during SSR hydration. The advisory states it "does not impact an application if
it is using Declarative Mode. It only impacts Framework Mode and Data Mode
applications that perform manual SSR/hydration." This app is declarative:
`BrowserRouter` at `packages/web/src/main.tsx:123`, `Routes`/`Route` in
`packages/web/src/App.tsx`, no `createBrowserRouter`, no `RouterProvider`, no
SSR. Not reachable.

There is no fix in the 6 line. The npm `version-6` dist-tag is 6.30.6, which is
what is installed. That line is terminal.

### What the upstream guide says

Fetched: `docs/upgrading/v6.md` at tag `react-router@7.18.0`.

Minimums for v7 are Node 20, React 18, react-dom 18. The repo is on React 18.3.1
and Node 20/24. No blocker.

The guide's step 2 is to enable six future flags on v6 one at a time. Four of
them (`v7_fetcherPersist`, `v7_normalizeFormMethod`, `v7_partialHydration`,
`v7_skipActionErrorRevalidation`) are `createBrowserRouter` options and do not
exist for this app. Two apply:

- `v7_relativeSplatPath` changes relative path matching under multi-segment
  splat routes like `dashboard/*`.
- `v7_startTransition` moves router state updates to `React.useTransition`. The
  guide says code changes are needed only where `React.lazy` is called inside a
  component.

Step 4 is the package swap. Step 5 is the import rename from `react-router-dom`
to `react-router`, with `RouterProvider` moving to `react-router/dom`.

### What breaks here

| Item | Count / location | Verdict |
|---|---|---|
| Splat routes | 1, `App.tsx:97`, `<Route path="*" element={<Navigate to="/channels/@me" replace />} />` | Bare `*`, not multi-segment, element navigates to an absolute path. `v7_relativeSplatPath` changes nothing. |
| `React.lazy` in components | 0 in `packages/web/src` | `v7_startTransition` is free. |
| `RouterProvider` | 0 | The `react-router/dom` subpath move does not apply. |
| Files importing `react-router-dom` | 35, of which 6 are tests | See below. |
| Tests mounting `MemoryRouter` | 6 files | Should pass unchanged. |
| Tests calling `vi.mock('react-router-dom', ...)` | 3: `FriendsPage.test.tsx:112`, `SpaceInviteCard.test.tsx:20`, `JoinSpace.test.tsx:23` | Highest-risk item. These intercept module identity, so they must be checked against whatever specifier the app ends up importing. |
| `<Route>` elements | 8, all in `App.tsx` | Unchanged between v6 and v7. |

The 35-file import rename is optional. `react-router-dom@7.18.3` still publishes
as a thin package whose only dependency is `react-router@7.18.0` and which
re-exports it. The minimum diff that clears both waivers is a single version
bump in `packages/web/package.json:30`, leaving all 35 import sites alone. Doing
the rename is cleanup and belongs in its own commit.

### Effort and blast radius

Half a day: bump, turn on the two applicable future flags, run
`pnpm --filter @backspace/web test`, click through login, join-by-invite, deep
links and the mobile bottom nav. Blast radius is the whole SPA's navigation, but
the surface that actually changes is small and the test suite already covers the
three mocked components.

Ships on its own. No coupling to the server work.

### Caveat

react-router `latest` is now 8.3.1. The v7-to-v8 guide raises minimums to Node
22.22, React 19.2.7 and react-dom 19.2.7, which means a React 19 migration of
the entire SPA. Do not fold that in. 7.18.3 clears both advisories.

---

## 2. fastify 4.29.1 to 5.12.1

### Driver

| Advisory | GHSA | Summary | Fixed in | Reachable here |
|---|---|---|---|---|
| CVE-2026-25223 | GHSA-jx2c-rxcm-jvmq | Tab character in `Content-Type` bypasses body validation | 5.7.2 | No |
| CVE-2026-25224 | GHSA-mrq3-vjjr-p77c | Unbounded buffering in `sendWebStream`, remote DoS | 5.7.3 | No |
| CVE-2026-3635 | GHSA-444r-* | `request.protocol` / `request.host` spoofable under a restrictive `trustProxy` | after 5.8.2 | No |
| CVE-2026-18504 | GHSA-w2qp-rph6-63g4 | Root primitive body schema coercion mismatch | 5.12.1 | No |

Why none of them lands:

- Two of the four need request schemas. `grep -rn "schema:" packages/server/src`
  excluding tests returns zero hits. No route in this server declares a body,
  querystring, params or response schema. Validation is hand-rolled inside the
  handlers (see `packages/server/src/routes/auth.ts:26-60`).
- CVE-2026-25224 needs a route that returns a Web `ReadableStream` or a
  `Response` from `reply.send()`. The only streaming route is
  `packages/server/src/routes/uploads.ts:74,80`, which uses
  `fs.createReadStream`, a Node stream, not a Web stream. The two
  `Readable.fromWeb(...)` calls in `utils/federationWorker.ts:912` and
  `routes/federation/profile.ts:161` are on the outbound fetch side, not a
  reply.
- CVE-2026-3635 only manifests with a restrictive `trustProxy`. This server sets
  `trustProxy: true` at `packages/server/src/index.ts:41`, which the advisory
  calls out as "expected behavior".

There is no fix in the 4 line. The npm `four` dist-tag is 4.29.1, which is
what is installed. Terminal.

Because the target is 5.12.1, this upgrade also has to clear all four at once;
5.7.3 is not enough for CVE-2026-18504.

### What the upstream guide says

Fetched: the Fastify v5 migration guide at
`https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/`.

The breaking changes it lists, checked one by one against this repo:

| v5 change | Hits in `packages/server/src` |
|---|---|
| Node 20+ required | Already Node 20/24 (`package.json:60`, `Dockerfile` on `node:24-slim`) |
| `.listen()` variadic form removed | Already the object form, `index.ts:220` |
| `request.routerPath` removed | 0 |
| `request.routerMethod` removed | 0 |
| `request.routeConfig` / `routeSchema` / `context` removed | 0 |
| `request.connection` removed | 0 |
| `reply.getResponseTime()` removed | 0 |
| `reply.redirect(code, url)` argument order flipped | 0 `reply.redirect` calls anywhere |
| `reply.sent` mutation forbidden | 0 |
| `getDefaultRoute` / `setDefaultRoute` removed | 0 |
| route `version` / server `versioning` removed | 0 |
| `jsonShortHand` removed | 0 |
| `decorateRequest` / `decorateReply` reference types banned | 0 `decorate*` calls at all |
| Full JSON Schema now required | 0 schemas |
| Params object loses its prototype chain | The only `hasOwnProperty` use is `routes/dm.ts:1520-1521`, and it is on `request.body`, not `request.params`, and already goes through `Object.prototype.hasOwnProperty.call`. Safe. |
| `req.hostname` no longer includes the port | No handler reads `request.hostname` or `request.host`. All `.hostname` reads are on `new URL(...)` objects (`routes/federation/origin.ts:65`, `utils/ssrf.ts`). |
| Non-standard HTTP methods removed | Only GET, POST, PATCH, DELETE are declared |
| `useSemicolonDelimiter` defaults to false | No querystring relies on `;` separators |

The core-API surface is clean. That is the good news and it is worth knowing
before scheduling: this is a plugin-ecosystem upgrade, not a route-rewrite.

### What actually breaks: the plugin block

Five plugins have to move majors in the same commit, because the fastify-5
versions bumped `fastify-plugin` from 4 to 5 or 6 and will not load under
fastify 4.

| Plugin | Current | First fastify-5 version | Latest | Documented break, and whether it lands |
|---|---|---|---|---|
| `@fastify/cors` | 9.0.1 | 10.0.0 | 11.3.0 | v11 changes the default `methods` to the CORS-safelisted set. `index.ts:64` passes `methods` explicitly, so no behavior change. |
| `@fastify/helmet` | 11.1.1 | 12.0.0 | 13.1.1 | v13 pulls helmet 7 to 8, which changes the default header set. `index.ts:101-118` overrides the headers this app cares about. `packages/server/test/http-security-headers.test.ts` is the gate. |
| `@fastify/rate-limit` | 9.1.0 | 10.0.0 | 11.2.0 | No documented break to `keyGenerator`, `allowList` or `errorResponseBuilder` as used at `index.ts:145-158`. The per-route `config.rateLimit` blocks (8 of them, in `auth.ts`, `users.ts`, `dm.ts`, `gif.ts`, `social.ts`, `messages.ts`, `explore.ts`, `federation/handlers/attach.ts`) keep the same shape. |
| `@fastify/websocket` | 10.0.1 | 11.0.0 | 11.3.0 | v11.0.0's only change is the fastify minimum. The handler-argument change (WebSocket instead of SocketStream) was v10 and is already absorbed: `ws/handler.ts:1674` is `app.get('/ws', { websocket: true }, (socket, request) => ...)`. |
| `@fastify/static` | 7.0.4 | 8.0.0 | 10.1.3 | Its own section below. |

`@fastify/multipart` 8.3.1 is declared in `packages/server/package.json:19` but
`grep -rn "@fastify/multipart\|multipart" packages/server/src` excluding tests
returns nothing. Uploads go through `@tus/server`. It does not need bumping
because it is not registered anywhere; it should be removed instead.

### Blast radius

- 26 `app.register(...)` calls in `packages/server/src/index.ts`.
- 105 route declarations across 20 files under `packages/server/src/routes/`
  (19 GET, and the rest POST/PATCH/DELETE, all using the
  `app.method<{ Body/Params/Querystring }>(...)` generic form, which v5 keeps).
- 3 `addHook` calls, one of which is the CSP `onSend` hook at `index.ts:130`.
- 44 test files under `packages/server/src` build their own Fastify instance and
  register route plugins directly, plus
  `packages/server/test/helpers/twoInstanceHarness.ts`. Any v5 incompatibility
  surfaces as a mass test failure rather than as a production surprise, which is
  the right failure mode.

### Effort

1 to 2 days. Most of it is running the suite, reading the helmet 8 default-header
delta against `test/http-security-headers.test.ts`, and confirming the two-instance
federation harness still boots.

Does not ship on its own: it has to carry `@fastify/static` and the four other
plugins in the same commit, and it drags `find-my-way` with it.

---

## 3. @fastify/static 7.0.4 to 10.1.3

### Driver

| Advisory | GHSA | Summary | Fixed in |
|---|---|---|---|
| CVE-2026-15074 | GHSA-83w8-p2f5-377r | Dot-dot segments not rejected before file resolution, bypasses route-scoped guards inside the static root | 10.1.1 |
| CVE-2026-7120 | GHSA-8pvw-jcv7-9cmj | `allowedPath` evaluated before dot-segment and duplicate-separator normalization | 10.1.2 |

The `reason` field in `osv-scanner.toml` says "fixed in 10.x". That is not
precise enough to clear both: CVE-2026-7120 needs at least 10.1.2. Current
latest is 10.1.3.

Neither is reachable as configured. Both advisories say the bypass "does not
allow access outside the configured static root by itself, it defeats path-based
filtering only". `packages/server/src/index.ts:162-166` registers the plugin
with `root: <web/dist>`, `prefix: '/'`, `wildcard: false`, no `allowedPath`, and
no route-scoped guard in front of it. There is no filter to bypass, and the
static root holds the built SPA, which is public by design.

### What the upstream changelog says

Fetched: the GitHub release notes for v8.0.0, v9.0.0 and v10.0.0.

- **v8.0.0** (2024-09-03): dependency majors only, `fastify-plugin` 4 to 5,
  `@fastify/send` 2 to 3, `@fastify/accept-negotiator` 1 to 2, `glob` 10 to 11.
  The `fastify-plugin` 5 bump is what makes v8 and up fastify-5-only.
- **v9.0.0** (2025-12-25): `content-disposition` 0.5 to 1.0, `glob` 11 to 13. No
  documented API change.
- **v10.0.0** (2026-07-11): one breaking change. `setHeaders` now receives a
  `FastifyReply` instead of a Node `Response`, so `res.setHeader(...)` becomes
  `reply.header(...)`. `setHeaders` can also now override send headers.

### What breaks here

Nothing. The registration passes no `setHeaders`, so the single documented API
break does not apply. The only other call site is `reply.sendFile('index.html')`
in the SPA not-found handler at `index.ts:215`, whose signature is unchanged
across all three majors.

### Effort and blast radius

Under an hour of code, once fastify 5 is in. Blast radius is the SPA fallback
and every asset served from `web/dist`, which is verified by loading the app
from the Docker image rather than from Vite.

Cannot ship on its own. v8 and up require fastify 5.

---

## 4. find-my-way 8.2.2 to 9.9.0

### Driver

CVE-2026-47219 / GHSA-c96f-x56v-gq3h. `lookup()` passes `req.method` into
`find()`, which indexes `this.trees[method]`. Because `this.trees` is a plain
object, an HTTP/2 method value such as `constructor`, `toString` or `__proto__`
resolves an inherited property instead of `undefined`, and the code then crashes
on `currentNode.prefix.length`. Remotely triggerable DoS.

The advisory text is internally inconsistent: it says "Versions prior to 9.7.0
are vulnerable" and then "This issue has been fixed in version 9.0.7". Treat
9.7.0 as the floor, because that is the version the affected-range statement
uses and the one `osv-scanner.toml` already records.

Not reachable. The vector requires Fastify running on a Node HTTP/2 server.
`grep -rn "http2" packages/server/src` returns nothing and the Fastify
constructor at `packages/server/src/index.ts:41` passes no `http2` option, so
the server is HTTP/1.1. Caddy terminates TLS and proxies over HTTP/1.1.

### What breaks here

Nothing directly. `find-my-way` is not a direct dependency;
`grep -rn find-my-way packages/*/package.json package.json` returns nothing. It
arrives through fastify.

The one real v9 behavior change (release v9.0.0, PR 333) is that the parameter
object is now a null-prototype object. That is the same change the fastify v5
guide describes, and it is already covered above: no handler calls
`hasOwnProperty` on `request.params`.

### Blocked on

fastify 4.29.1 pins `find-my-way: ^8.0.0`, and the 8 line ends at 8.2.2 (npm
`eight` dist-tag). There is no way to satisfy this waiver while staying on
fastify 4. fastify 5.12.1 depends on `find-my-way: ^9.6.0`, which resolves to
9.9.0 today.

### Effort

Zero beyond the fastify 5 upgrade. This is not a separate task and should not be
scheduled as one. It is listed here only because it is a separate waiver entry.

---

## 5. electron 40.10.6, and why 41 is the wrong target

### Driver

CVE-2026-70608 / GHSA-9f4c-93c8-jc8g. A sandboxed iframe without the
`allow-popups` keyword could still open a new window or trigger
`setWindowOpenHandler` with no user interaction, because new-window navigations
taking the OpenURL path did not apply the iframe sandbox popup restriction.
Fixed in 39.8.10, 41.10.3 and 42.0.1. Not fixed in the 40 line, which is why
this waiver exists at all.

Not reachable. The advisory says apps "that deny window creation in
`setWindowOpenHandler` [...] are not affected". The handler at
`packages/desktop/src/main.ts:456-472` returns `{ action: 'deny' }` on every
path: the `/join/` case denies after forwarding the route in-process, the
http/https case denies after `shell.openExternal`, and the fall-through denies.
No code path returns `allow`. The app never creates a window from that handler.

### The version decision, which is the real content of this section

Fetched: `https://releases.electronjs.org/schedule`.

| Major | Stable | End of life |
|---|---|---|
| 40.0.0 | 2026-01-13 | 2026-06-30 (passed) |
| 41.0.0 | 2026-03-10 | **2026-08-25 (passed)** |
| 42.0.0 | 2026-05-05 | 2026-10-20 |
| 43.0.0 | 2026-06-30 | 2027-01-05 |
| 44.0.0 | 2026-08-25 | 2027-03-02 |

npm `latest` is 44.1.1. The support policy is the latest three stable majors, so
the supported set today is 42, 43 and 44.

Electron 41 reached end of life on 2026-08-25, nine days ago. Upgrading to
41.10.3 buys the fix for this one advisory and no future ones, on a line that
receives no further security patches. Electron 42 goes end of life on
2026-10-20, before the 2026-12-01 waiver expiry.

**The viable targets are 43 and 44.** The `osv-scanner.toml` reason line, which
says "Needs the 41 upgrade plus fuse re-verification", should be corrected when
this is scheduled.

### What breaks between 40 and 44

Fetched: `docs/breaking-changes.md` from `electron/electron` at `main`, sections
41.0 through 44.0.

**41.0**

| Change | Applies here |
|---|---|
| PDFs no longer create a separate `WebContents` | No PDF handling in `packages/desktop/src` |
| Cookie `changed` event cause values updated | No cookie listeners |
| `showHiddenFiles` in Linux dialogs deprecated | Not used |

41 also adds digest embedding for asar integrity. `docs/systems/desktop-security.md`
already tracks the asar-integrity posture and the limits imposed by ad-hoc
signing; that section needs revisiting after the bump.

**42.0**

| Change | Applies here |
|---|---|
| macOS notifications move to `UNNotification`, which "requires that an application be code-signed in order for notifications to be displayed. If an application is not code-signed, notifications will emit a `failed` event on the `Notification` object." | **Yes, and this is the largest unknown.** `showNotification()` at `packages/desktop/src/main.ts:513-515` constructs `new Notification(...)` and is called for DM and mention alerts (`main.ts:527`, `main.ts:765`). macOS builds are signed ad-hoc only, by `packages/desktop/scripts/macSign.js` with `codesign --force --sign -`. Whether an ad-hoc signature counts as code-signed for `UNNotification` must be tested against a real packaged build. It cannot be reasoned out from the docs. |
| `electron` no longer downloads itself in a `postinstall` script; the binary downloads on first `bin` run, and `ELECTRON_SKIP_BINARY_DOWNLOAD` stops working | `grep -rn ELECTRON_SKIP_BINARY_DOWNLOAD` over `.github/`, `Dockerfile`, `*.sh` and `package.json` returns nothing. No change needed, but the four release runners in `.github/workflows/release.yml` will each pay a download on first `electron-builder` invocation. |
| `Session.clearStorageData` loses `options.quotas` | Not used |
| Offscreen rendering default `deviceScaleFactor` becomes 1.0 | No offscreen rendering |
| `nativeImage.createFromNamedImage()` array-only `hslShift` deprecated | Only `createFromBuffer` (`main.ts:296`) and `createFromPath` (`main.ts:306,314,322`) are used |

**43.0**

| Change | Applies here |
|---|---|
| Dialog methods default to the Downloads directory | No `dialog.` call sites in `packages/desktop/src/main.ts` |
| `showHiddenFiles` removed on Linux | Not used |
| `NativeImage.toBitmap()` normalizes color space; Linux rounded corners; WCO title-bar layout on Linux | Cosmetic, no code change |

**44.0**

| Change | Applies here |
|---|---|
| macOS 12 support removed, macOS 13 required | **Yes.** `packages/desktop/electron-builder.yml` sets `mac.minimumSystemVersion: "12.0"` and would have to become `"13.0"`. This drops Monterey users. |
| Windows ia32 and Linux armv7l binaries no longer published | No. The matrix in `.github/workflows/release.yml:24-37` builds `--mac --arm64 --x64`, `--win --x64 --arm64`, `--linux --x64` and `--linux --arm64`. |
| `clipboard` removed from the renderer | No. `grep -rn clipboard packages/desktop/src` returns nothing. |
| ANGLE statically linked, `libEGL`/`libGLESv2` no longer shipped | No. `packages/desktop/scripts/afterPack.js` does not touch them. |
| `net.request` rejects frame destinations without navigate mode | No `net.request` call sites in `main.ts` |
| `select-client-certificate` may pass a null `webContents` | Event not handled |
| ANGLE now loaded into every process | Watch for GPU regressions on the Linux AppImage |

### Non-API costs, which are the larger half

- **Native module ABI.** `uiohook-napi` 1.5.5 is rebuilt by `electron-rebuild`
  in the desktop `postinstall`. Electron 41 moves to Node 24.14.0 and V8 14.6
  from Electron 40's Node 22 line. The installed package ships Node-API
  prebuilds under `prebuilds/<platform>-<arch>` resolved by `node-gyp-build`
  (darwin arm64/x64, linux arm64/x64, win32 arm64/x64), and Node-API is ABI
  stable across Electron majors, so the prebuilds should survive. The residual
  risk is the forced `electron-rebuild -f -w uiohook-napi`, which recompiles
  against the new headers, and the `afterPack.js` cleanup at lines 52-81 that
  strips `build/` and non-target `prebuilds/` entries. Verify global keybinds
  actually work on a packaged build, not on `pnpm dev`.
- **Fuse verification.** `.github/workflows/release.yml:124-210` reads the fuse
  wire back with `@electron/fuses` on all six shipped artifacts and fails the
  release if `RunAsNode`, `EnableNodeCliInspectArguments` or `OnlyLoadAppFromAsar`
  is not what it expects. `packages/desktop/scripts/afterPack.js:118-140` flips
  them before `macSign.js` seals the macOS bundle, and that ordering is
  deliberate and documented in `docs/systems/desktop-security.md`. Both have to
  pass again against the new binary layout.
- **electron-builder.** 26.15.3 has to be checked against the target Electron
  major before the release matrix is trusted.

### Effort and blast radius

2 to 3 days, most of it release-pipeline verification across four runners and
six artifacts rather than code. Blast radius is the entire desktop app, and the
failure mode is a release that builds but does not launch or does not notify.

Ships on its own. No coupling to the server or web upgrades.

---

## Recommended order

**1. react-router-dom 6.30.6 to 7.18.3.**
It is the only one of the five whose advisory is actually reachable in the
shipped product, it is fully independent, and the minimum diff is a single
version line because `react-router-dom@7` is still published as a re-export of
`react-router@7`. Clears 2 of 13 waivers for roughly half a day.

**2. fastify 4 to 5, carrying @fastify/static to 10.1.3 and the four other
plugin majors in one commit.**
find-my-way clears for free. This is 7 of the 13 waivers in a single change, the
core API surface is clean (zero hits on every removed request and reply
property), and 44 test files boot real Fastify instances so breakage is loud and
immediate. It is the largest unit of work but nothing gates it, so it should not
wait behind the Electron decision.

**3. electron 40 to 43 or 44.**
Last, because the work here is not the code, it is deciding a version and then
verifying six artifacts on four runners. It also carries the one question that
cannot be answered from a document: whether ad-hoc signing satisfies
`UNNotification` on macOS from 42 onward. That wants a real packaged build and a
real Mac, which is the slowest feedback loop of the three.

Steps 1 and 2 do not touch each other and can run in parallel if there are two
people. Step 3 should not start until the version target is confirmed against
the release schedule on the day it is scheduled, since 43 goes end of life on
2027-01-05.

## Blocked

Nothing is blocked outright. No transitive dependency is missing a compatible
release.

`find-my-way` cannot move while the repo stays on fastify 4, but that is a
sequencing constraint satisfied by step 2, not a wall.

The one item that could turn into a wall is the macOS notification behavior from
Electron 42 onward. If an ad-hoc signature does not satisfy `UNNotification`,
the choice is between shipping a desktop app with silently broken macOS
notifications and procuring a Developer ID certificate, which
`docs/systems/desktop-security.md` already scopes as a separate piece of work
with a cost and a lead time. Test this before committing to the Electron
schedule.

## Sources

Fetched and read for this document:

- Fastify v5 migration guide, `https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/`
- `@fastify/static` release notes for v8.0.0, v9.0.0 and v10.0.0 on GitHub
- `find-my-way` release notes for v9.0.0 on GitHub
- React Router `docs/upgrading/v6.md` at tag `react-router@7.18.0`
- Electron `docs/breaking-changes.md` at `main`, sections 41.0 through 45.0
- Electron release schedule, `https://releases.electronjs.org/schedule`
- Electron 41 release blog post
- OSV API records for all ten advisories, for affected ranges, fixed versions and
  the exploitability preconditions quoted above
- npm registry metadata for `fastify`, `@fastify/static`, `@fastify/cors`,
  `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/websocket`,
  `@fastify/multipart`, `find-my-way`, `react-router`, `react-router-dom` and
  `electron`, for dist-tags, peer dependencies and terminal versions of the old
  lines

Not fetched: the `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit` and
`@fastify/websocket` upgrades were assessed from their GitHub release notes
only. Those projects do not publish separate migration guides. The helmet 7 to 8
default-header delta in particular was not read directly and is the one item in
the fastify section that rests on the test suite rather than on a document.
