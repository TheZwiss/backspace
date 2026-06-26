# Contributing to Backspace

Thanks for considering a contribution! Backspace is an open, source-available
project and contributions of all sizes are welcome — bug reports, fixes,
features, documentation, and design.

## Before you start

- **Read the architecture docs.** The `docs/systems/` directory documents every
  subsystem (database, API, WebSocket protocol, federation, permissions, voice,
  design system, and more). Read the relevant spec before changing a subsystem,
  and update it in the same pull request if your change is structural.
- **Open an issue first for anything non-trivial.** It saves you from building
  something that conflicts with planned direction. Small fixes can go straight
  to a pull request.
- **One logical change per pull request.** Keep diffs focused and reviewable.

## Contributor License Agreement (required)

Before your first contribution can be merged, you must sign the project's
[Contributor License Agreement](CLA.md).

Backspace is a single-owner project. The CLA **assigns copyright in your
contribution to the maintainer (Jannis Braun)**, who becomes its sole owner and
may license the project under any terms, including commercially. In return, you
receive a perpetual license to reuse the specific code you authored in your own
other projects (see CLA §5). You also confirm that you have the right to
contribute the code in the first place. If you are not comfortable assigning
your contribution, please do not submit it.

Signing is automatic and takes one comment:

1. Open your pull request.
2. The CLA bot will comment with a link to the agreement and ask you to sign.
3. Reply on the pull request with exactly:

   > I have read the CLA Document and I hereby sign the CLA

4. The bot records your signature against your GitHub username. You only sign
   once — it covers all of your future contributions.

## Development setup

Requirements: **Node.js 20+** and **pnpm 8+**.

```bash
pnpm install          # install all workspace dependencies
cp .env.example .env  # then set JWT_SECRET (openssl rand -hex 32)
pnpm dev              # API server on :3005, Vite dev server on :5173
```

You can run the two halves separately with `pnpm dev:server` and `pnpm dev:web`.

Voice and video are optional and require a LiveKit server; see the README for
configuration. Text, federation, uploads, and everything else run fully without
it.

## Coding standards

- **TypeScript strict mode**, no `any`. The codebase compiles cleanly under
  strict settings — keep it that way.
- **Match the surrounding code.** Follow existing patterns, naming, and module
  boundaries rather than introducing new ones.
- **Federation-aware.** Never assume a single global user ID. Resolve the
  correct federated identity for the relevant instance when comparing IDs,
  checking permissions, or talking to remote servers. See
  `docs/systems/federation.md` and `docs/systems/client-federation.md`.
- **Design system.** UI work follows the "Aether Drift" design system documented
  in `docs/systems/design-system.md`.
- **No new dependencies without justification.** Prefer the existing stack.
- **Complete implementations only.** No placeholder code, no `TODO` stubs, no
  partial components. Handle the error and edge cases.

## Before you open a pull request

- `pnpm build` succeeds (shared types, server, and web all build).
- The dev server and web client both start without errors (`pnpm dev`).
- Tests pass (`pnpm test` where applicable to the package you touched).
- You updated the relevant `docs/systems/` spec if your change altered schema,
  API routes, WebSocket events, the federation protocol, permissions, or the
  design system.

## Reporting bugs and requesting features

Use GitHub Issues. For bugs, include reproduction steps, expected vs. actual
behavior, and your environment (deployment method, browser/desktop, and whether
federation or voice is involved). For security issues, please do **not** open a
public issue — see the README's security section.

## License

By contributing, you agree that your contributions are licensed under the
[Elastic License 2.0](LICENSE) and are subject to the [CLA](CLA.md).
