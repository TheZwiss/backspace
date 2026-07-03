// Vitest setup: provides test-only defaults for env vars that config.ts
// requires at module-load time. Without this, every test that transitively
// imports a server module aborts during import when .env is absent (fresh
// worktrees, CI without secrets, contributor first-run). Real .env values
// still take precedence — `??=` only fills holes.

process.env.JWT_SECRET ??= 'test-only-jwt-secret-not-for-production-use!!';
