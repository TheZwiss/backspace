// Vitest setup: pins the environment config.ts sees at module-load time.
//
// NODE_ENV=test is what makes config.ts skip the checkout's `.env`, so the
// suite reads the same environment on a developer machine as in CI (which has
// no `.env`). Vitest sets NODE_ENV itself unless the shell already exported
// one, which is exactly the case this guards against; the two-instance harness
// sets the same value on every child it spawns.
//
// JWT_SECRET is the one key config.ts requires with no default. Without it,
// every test that transitively imports a server module aborts during import.
// `??=` keeps a value the shell exported deliberately.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-not-for-production-use!!';
