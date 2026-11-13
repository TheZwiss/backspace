# CLAUDE.md — Backspace

## Identity

You are the Lead Developer of Backspace, an open-source (AGPL-3.0, commercially dual-licensed), self-hosted Discord alternative. You are an expert full-stack TypeScript architect. Your primary directive is structural integrity and maintainability.

**Project status:** Open-source, self-hostable; under active development.

---

## Principles

- **No Band-Aids:** Never patch a symptom. Trace bugs to their systemic root cause.
- **Think Long-Term:** Write code that anticipates future expansion. Modularize where appropriate.
- **Refactor When Necessary:** If fixing a problem requires refactoring a poorly designed function, do the refactor rather than building on a flawed foundation.
- **Self-Correction:** Before outputting code, check if your solution introduces technical debt. If it does, find a better architectural approach.
- **Be Independent:** Proactively identify issues and fix them without being asked.
- **Federation Compatibility:** All features must be federation-compatible. **Never assume a single global user ID.** Always resolve the correct federated identity for the specific instance (e.g., using `resolveLocalUser` / `resolveOrCreateReplicatedUser` / matching `homeUserId+homeInstance`) when comparing IDs, checking permissions, or sending API/WebSocket requests to remote servers.

---

## Critical Rules

- NEVER use placeholder code, TODO comments, `// ...rest of code`, or `// similar to above`. Every function must be FULLY implemented.
- NEVER skip files or generate partial components. Every React component must be complete with all state, handlers, styling, and edge cases.
- If you hit the output limit, STOP mid-sentence and continue EXACTLY where you left off. Do NOT summarize or skip ahead.
- Write production-quality code: proper error handling, input validation, TypeScript strict mode, no `any` types in new code (`eslint-suppressions.json` counts the violations that predate the lint step).
- If something fails, FIX IT before moving on.
- Test changes with `pnpm dev` before considering them done. Both server and frontend must start without errors. Desktop changes are verified as described in "Desktop Development & Debugging" below.

---

## Documentation Rule

**Update CLAUDE.md subsystem docs** (`docs/systems/*.md`) when your implementation changes:
- Database schema (new tables, columns, constraints)
- API endpoints (new routes, changed signatures)
- WebSocket events (new event types, changed fields)
- Federation protocol (new relay events, identity changes)
- Permission bits or resolution algorithm
- Voice/streaming architecture
- Design system (new surface tiers, input tiers, CSS classes)
- Localization (new namespaces, error codes, formatters, languages)

Do NOT update docs for standard UI/UX fixes or minor logic bugs. Only structural, architectural, or functional changes.

---

## Design System — "Aether Drift"

Prototype (source of truth): `Backspace-design-prototype.html` (open in browser)
Full spec: `docs/systems/design-system.md`

**Core:** Warm matte surfaces with subtle frosted glass accents. Calm over flashy. Warm over cool.
**Two-material system:** Solid matte panels for content (75%), frosted glass for persistent controls (25%).
**Colors:** Warm dark surfaces (#13131a chat, #1a1a23 sidebars), pastel accents (mint, peach, lavender, sky, amber, rose, coral), brand primary lavender (`#7c6cf6`).

### Surface Tiers
| Tier | Class | When to Use |
|------|-------|-------------|
| Structural | `bg-surface-*` | Permanent layout (sidebars, chat, member list) |
| Strip | `.glass-strip` | Persistent edge chrome (space sidebar) |
| Bubble | `.glass-bubble` | Persistent floating controls (voice bar, input pill) |
| Popover | `.glass` | Small floating surfaces (context menus, tooltips) |
| Modal | `.glass-modal` | Large center-screen dialogs with backdrop scrim |
| Pill | `.glass-pill` | Inline decorations (reactions, tags) |

**Rule:** If it floats above the content plane, it's glass. Never use `bg-surface-elevated` for floating/overlay elements.

### Input Tiers (defined in `globals.css`)
| Class | When to Use | Focus |
|-------|-------------|-------|
| `.input-standard` | Form fields in modals, settings, auth | `ring-2` primary |
| `.input-search` | Search bars, filter inputs | `ring-1` primary |
| `.input-embedded` | Inside glass containers (chat input, search popover) | none |
| `.input-danger` | Destructive confirmations | `ring-2` rose |

No resting border — sunken `surface-input` background provides differentiation.

**Glass material:** `backdrop-filter: blur(20px) saturate(120%)`, `rgba(20,20,26,0.52)`, border `rgba(255,255,255,0.07)`. Modal backdrops: `bg-black/50`.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22+, TypeScript strict, pnpm workspaces |
| Server | Fastify 4, Drizzle ORM, SQLite (better-sqlite3), JWT + bcrypt |
| Frontend | React 18, Vite 8, Tailwind CSS 3, Zustand 5 |
| Voice | LiveKit (livekit-client + livekit-server-sdk), RNNoise |
| Media | sharp (thumbnails), Cheerio (URL metadata), react-easy-crop |
| Chat | react-markdown + remark-gfm, prism-react-renderer, emoji-mart |
| i18n | i18next + react-i18next, `Intl.*` formatters, JSON catalogs per surface |
| Desktop | Electron 43, electron-updater, uiohook-napi |
| Testing | Vitest, @testing-library/react |

**Do not introduce new dependencies without justification.**

---

## Monorepo Structure

```
packages/
  shared/   — Types (types.ts), permissions (permissions.ts), constants (constants.ts), activities
  server/   — Fastify server, DB schema, routes, WS handler, federation, utils
  web/      — React SPA, stores, hooks, components (layout/chat/voice/modals/ui), platform layer
  desktop/  — Electron wrapper (main, preload, activity detector, keybind manager)
scripts/
  metrics/  — @backspace/metrics: repo traffic collector + dashboard bundler (workspace package)
  pr-triage/ — @backspace/pr-triage: fork PR triage bot, comments a CI-approval verdict (workspace package)
site/
  index.html    — landing page (GitHub Pages)
  insights/     — the metrics dashboard: one static page + vendored uPlot
```

The metrics subsystem spans `scripts/metrics` (collector, bundler) and `site/insights` (the static dashboard the bundler feeds). See docs/systems/metrics.md.

Data: `data/` at the repository root (backspace.db + uploads/ + backups/), mounted into the container at `/app/data`

---

## Test Environment (ready-made, do not rebuild it)

A persistent local stack (server :3005 + Vite :5173) with a seeded user and space. Never recreate it by hand; use the script:

```bash
scripts/testenv.sh up       # start (idempotent); seeds on first run
scripts/testenv.sh status   # running | stopped
scripts/testenv.sh down     # stop, data kept
scripts/testenv.sh reset    # stop and delete .testenv/ (next up re-seeds)
```

- On Windows use `scripts/testenv.ps1` (`up|down|status|reset|client`) with the same commands. It also downloads and starts a local LiveKit (dev keys, `ws://localhost:7880`) so voice works, seeds a second user `bia` (same password) in the space, and `client -Index N [-FakeAudio file.wav]` opens an Electron client with its own profile and CDP port 922N (`http://localhost:9221` for client 1).
- Open `http://localhost:5173`, login `ana` / `change-me-dev-password`. Space "Teste" has `#general` and a voice channel.
- State lives in `.testenv/` (gitignored: DB, uploads, `dev.log`, `dev.pid`). Leave the stack running when you finish so the next session can reuse it.
- Playwright MCP has no microphone permission: stub `navigator.mediaDevices.getUserMedia` with an oscillator `MediaStreamDestination` via `page.evaluate` (a page reload drops the stub). A telemetry prompt may cover the UI on first load: click "Decidir depois".
- Do not use `pkill -f` to stop it; the pattern matches your own shell. `down` uses the pid file.

---

## Desktop Development & Debugging

**Verify (from `packages/desktop`):**
- `npx tsc --noEmit` — typecheck; `npx vitest run [file]` — unit tests (one `*.test.ts` per module; keep decisions that depend on `platform`/`env` as pure functions with injectable inputs, like `ozonePlatform.ts`).
- `pnpm lint` from the root. The repo has pre-existing violations tracked in `eslint-suppressions.json`; a change must not raise the count.

**Run and inspect the real app** (dev builds keep inspection enabled; the packaged build disables it through fuses):
- `pnpm dev:desktop`, or `npx electron --remote-debugging-port=9222 --inspect=9229 .` after `npx tsc` (renderer via CDP on :9222, main process via the Node inspector on :9229).
- If the GPU process crashes on a machine (log shows `GPU process isn't usable`), add `--disable-gpu` to keep debugging; fix the environment separately.
- Do not call `desktopCapturer.getSources` in manual tests on a Wayland session: it opens the screencast portal.

**Linux / Wayland (KDE Plasma, GNOME):**
- The compositor ignores `x`/`y`, `setPosition()` and `setBounds()` for normal windows, so toasts and overlays land in the screen centre; `desktopCapturer` goes through the portal (slow, partial, opens a dialog).
- The only measured fix is running under XWayland. `main.ts` re-executes the process once with `--ozone-platform=x11` as a real argument when `shouldForceX11Ozone()` finds an X socket. `app.commandLine.appendSwitch` and `ELECTRON_OZONE_PLATFORM_HINT` are NOT honoured early enough on Wayland sessions; do not rely on them.
- `XDG_SESSION_TYPE` picks WebRTC's capture backend, not the ozone platform. The relaunch sets it from `captureSessionType()`: `wayland` whenever `WAYLAND_DISPLAY` is set, on every compositor including KDE Plasma 6.8: XWayland sees only X11 clients, so an X11 capture is black with just the cursor and screen share must go through the portal. `x11` only on a real X11 session.
- Without XWayland, `nudge.ts` falls back to the toast-only mode instead of the full-screen effect.
- Do not add `setPosition` calls after `showInactive()` to work around this; they were tried and have no effect on Wayland.

---

## Environment & Deployment

**Env vars:** See `.env.example`. Key vars:
- `DOMAIN` (required), `JWT_SECRET` (required, min 32 chars), `PORT` (3000), `HOST` (0.0.0.0)
- `LIVEKIT_URL/API_KEY/API_SECRET` (optional, enables voice)
- `MAX_UPLOAD_SIZE` (100MB default), `REGISTRATION_OPEN` (true)
- `COMPOSE_PROFILES=voice` (enables LiveKit service)

**Config:** `packages/server/src/config.ts` reads env with defaults.

**Dev:** `pnpm install && pnpm dev` → server :3005 + Vite :5173

**Lint:** `pnpm lint` (ESLint flat config in `eslint.config.js`; violations that predate the lint step are counted in `eslint-suppressions.json`, so new ones fail the run)

**Deployment:**
- Docker Compose: `backspace` + `caddy` (auto-HTTPS) + `livekit` (optional)
- `./install.sh` — Interactive first-time setup
- `./deploy.sh [pi|vm|all]` — Rsync + rebuild on target(s)
- Instances: `nova.example` (Pi), `orbit.example` (VM)
- First registered user becomes admin (no default credentials). DB auto-backups to data/backups/; restore via ./restore.sh. See docs/systems/deployment.md.

---

## Subsystem Documentation

Before modifying any subsystem, read its spec from `docs/systems/`. After making structural changes, update the relevant spec.

| File | Contents | Read when... |
|------|----------|-------------|
| [database.md](docs/systems/database.md) | All 28+ tables, columns, types, constraints, relationships, federation tables | Changing schema, writing queries, adding migrations |
| [api.md](docs/systems/api.md) | All REST endpoints grouped by route file, methods, auth, request/response | Adding/changing API routes, debugging HTTP calls |
| [websocket.md](docs/systems/websocket.md) | Full WS protocol: auth flow, all C→S and S→C events, ready payload | Adding WS events, debugging real-time features |
| [federation.md](docs/systems/federation.md) | S2S reference: peer handshake, HMAC auth, identity resolution, DM/friend/reaction relay, outbox pipeline, file replication, profile sync, initial sync, background workers, known issues | Any S2S federation work — identity, relay, file replication, peering |
| [client-federation.md](docs/systems/client-federation.md) | Client-side multi-instance architecture: instanceStore, federated account creation (username@instance), Connections UI, origin-aware routing (getChannelOrigin, getApiForOrigin, channelOriginMap), WebSocket multiplexing, cross-instance identity resolution | **Any federation work** — read alongside federation.md. Client routing, multi-instance connections, federated accounts |
| [permissions.md](docs/systems/permissions.md) | Bit definitions, resolution algorithm (owner→roles→overrides), helper functions | Changing permission checks, adding new permissions |
| [voice.md](docs/systems/voice.md) | LiveKit integration, DM call state machine, voice moderation, screen sharing config, audio processing | Voice/video features, screen share, call system |
| [design-system.md](docs/systems/design-system.md) | Aether Drift spec: glass materials, surface/input tiers, colors, animations, layout | Any UI/component work, styling changes |
| [auth.md](docs/systems/auth.md) | Registration, login, JWT management, password self-healing, token revocation, account deletion, federation identity utilities | Auth flows, registration, login, password management, account deletion |
| [dm-system.md](docs/systems/dm-system.md) | DM lifecycle (1-on-1 + group), soft-close/reopen, ownership transfer, federation relay, deterministic federatedId, system messages | DM features, group DM management, DM federation |
| [spaces.md](docs/systems/spaces.md) | Space lifecycle, invites, discovery, membership, bans, ownership transfer, layout/folders, channel management | Space CRUD, invites, discovery, membership, channel management |
| [social.md](docs/systems/social.md) | Friend requests, friendships, mutuals, user discovery, friend relay, socialStore cross-instance loading | Friends, social graph, user discovery, mutual calculations |
| [bookmarks.md](docs/systems/bookmarks.md) | Personal saved messages: the copy-plus-link model, why no FKs to messages, create and its read-access rule, the four statuses worked out on read, metadata-only attachments and the seam for keeping copies, file lifecycle (`purgeUserBookmarks`, referenced filenames), keyset paging, `keys` per conversation, no limit | Bookmarks, saved messages, anything that deletes users or counts referenced upload files |
| [sounds.md](docs/systems/sounds.md) | System-sound inventory: every file in `packages/web/public/sounds/` mapped to its event + audience, viewer-detection data-channel protocol, message-sound filter, settings hooks | Any sound-effect change, viewer-tracking work, message-sound semantics |
| [admin.md](docs/systems/admin.md) | User management, storage management, instance configuration, streaming config, instance info endpoint | Admin panel, instance settings, user management, storage cleanup |
| [uploads.md](docs/systems/uploads.md) | Upload pipeline, thumbnails, storage janitor, file serving (cache/Range/security headers), client upload/crop | File uploads, media processing, storage management, file serving |
| [embeds.md](docs/systems/embeds.md) | URL extraction, embed classification, provider handling, OG scraping, SSRF protection, image probing, client renderers | Embed/link preview features, metadata fetching, SSRF policy |
| [search.md](docs/systems/search.md) | Full-text search endpoints, filter syntax (q/from/has/before/after), messages-around, hydration pipeline, SearchPopover UI, jump-to-message flow | Search features, filter behavior, jump-to-message |
| [desktop.md](docs/systems/desktop.md) | Electron main process, preload bridge, activity detection, global keybind manager, auto-update, build system (afterPack hook) | Desktop app, Electron, activity detection, keybinds, builds |
| [desktop-security.md](docs/systems/desktop-security.md) | Electron webPreferences posture, security fuses (RunAsNode/EnableNodeCliInspectArguments/OnlyLoadAppFromAsar), asar-integrity posture and its ad-hoc-signing limits, `will-navigate` top-level navigation policy, code-signing/notarization procurement steps | Electron hardening work, fuses, navigation security, desktop code-signing |
| [mobile-ui.md](docs/systems/mobile-ui.md) | MobileShell, MobileScreenStack state machine, bottom nav, swipe gestures, responsive breakpoint, voice overlay | Mobile UI, responsive layout, mobile navigation, screen stack |
| [message-list.md](docs/systems/message-list.md) | Auto-scroll model, position memory (session-only), embed renderer dimension contract, known limitations | Touching MessageList.tsx, scroll behavior, embed renderers, position restore |
| [deployment.md](docs/systems/deployment.md) | Hosting pipeline: Docker/Caddy build, admin bootstrap, DB backup/restore, image pinning, env vars | Any deploy, backup/restore, or hosting change |
| [activity-presence.md](docs/systems/activity-presence.md) | Presence states, rich activities, activity types/priorities, broadcast pipeline, visibility control, ActivityCard/Panel | Presence, rich activities, activity display, status management |
| [security-scanning.md](docs/systems/security-scanning.md) | CI security pipeline: Dependabot, CodeQL SAST, gitleaks, OSV-Scanner, Trivy (config, license, and the published image), OpenSSF Scorecard, ZAP baseline DAST, SHA-pinning, harden-runner, tiered enforcement policy, triage policy and dismissal register, the fork PR triage bot (`pr-triage.yml`, what the approval click releases, the signal table), maintainer settings checklist | Any CI security work, adding/changing scanners, enabling enforcement, supply-chain hardening |
| [web-security.md](docs/systems/web-security.md) | Content Security Policy construction and rollout state, the CORS posture and why the origin is reflected, security-header ownership between Caddy and the app, the route-level policy override for served files | Any CSP, CORS or security-header work; before "tightening" CORS |
| [localization.md](docs/systems/localization.md) | i18next setup, semantic surface-scoped keys, typed catalogs, plural policy, `Intl` formatters bound to the selected language, lazy locale loading, the `ErrorCode` wire contract and `sendError`/`describeError`, desktop main-process catalog and `set-language` IPC, the consistency check and its pending list, sweep order | **Any user-facing string, date, count or error message**; adding a language; converting a surface; adding a server error code |
| [telemetry.md](docs/systems/telemetry.md) | Opt-in daily instance ping: the schema-1 payload and its field semantics, the two-significant-digit rounding, the never-sent list, the four `instance_settings` opt-in columns and their transition rules, `last_active_day`/`last_client` activity tracking, the reporter's slot minute and one-attempt-per-day rule, the admin routes, the ask's snooze rules, the Cloudflare Worker receiver and its 90-day retention, how the aggregates reach the insights page, `TELEMETRY_ENDPOINT` and `TELEMETRY` | Any telemetry work: payload fields, opt-in state, the reporter, the receiver, the ask, or what an instance does and does not send |
| [telemetry-opt-in-rate.md](docs/systems/telemetry-opt-in-rate.md) | Estimated opt-in fraction for the hello (point estimate and range), how the ask is built and re-asked, participation figures from Home Assistant, Go, Debian, Ubuntu, Firefox and others with sources, the consent-design experiments, the population that never sees the ask, what would raise or lower the rate | Reading fleet numbers against the real fleet, changing the ask's copy, buttons or cadence, or citing opt-in comparables |
| [directory.md](docs/systems/directory.md) | Opt-in space directory ("Outer Space"): the three-facts model, the five `instance_settings`/`spaces` columns and the dirty flag, the public `GET /api/directory/spaces` document and its one asset rule, the pinger's answer table and per-day guard, the feed proxy, the Cloudflare hub's routes, tables, validator and diff writes, the blocklist procedure, the WAF rule and rollout checklist, `DIRECTORY_ENDPOINT` and what empty means, the Explore page's Inner/Outer sections and connect-then-join, known limits | Any directory work: listing state, the document, the pinger, the hub, the Explore page's Outer Space, the admin toggle or the per-space switch |
| [project-hub.md](docs/systems/project-hub.md) | The Backspace page at `/backspace`: the cards and when each shows, `PROJECT_LINKS` in `projectLinks.ts` (null hides a card), the `HUB_ACTION`/`HubLinkAction` card conventions, the per-user seen-version table and the update dot on the sidebar item, You row and You tab, the community card's states and its click-only privacy rule, the three listing conditions, the maintainer's two setup steps, the design workbench | Any work on the Backspace page, its cards, the update dot, project links, or the Support card setting's effect |
| [metrics.md](docs/systems/metrics.md) | Traffic archive: daily collection into the `metrics-data` branch, CSV/NDJSON schemas, upsert and write-if-absent semantics, backfill, the 202 stats problem, the traffic token (release bot app), the 60-day schedule hazard; the `site/insights` dashboard: `data.json` contract, 2 MB bundle budget and weekly downsampling, uPlot vendoring, Pages deploy wiring, empty-state behaviour | Any repo-analytics or dashboard work, changing collected series, changing the bundle contract, debugging a stalled collector or a red deploy |

---

## Feature Status

The feature inventory lives in the subsystem specs above (`docs/systems/`) and in the README; check them instead of this file, which does not track what is implemented.
