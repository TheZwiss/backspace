/**
 * The largest file the service worker precaches. Workbox leaves any bigger
 * file out of the precache manifest with only a build warning, so a main chunk
 * that grows past it silently stops being cached: offline start and the update
 * flow in `SwAutoUpdate` then change without any error.
 *
 * `vite.config.ts` builds the worker with this value, and
 * `scripts/check-precache-size.mjs` reads it from here to fail CI when any
 * precached file comes within 10% of it.
 */
export const PRECACHE_MAX_FILE_BYTES = 3 * 1024 * 1024;
