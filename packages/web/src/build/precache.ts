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

/**
 * The file types the service worker precaches: the worker is built with
 * `PRECACHE_GLOB_PATTERNS`, and `scripts/check-precache-size.mjs` reads this
 * list to know which unlisted build assets workbox left out for size. Any
 * other file (fonts, images) is never a precache candidate, whatever its size.
 * These are workbox's own defaults, written down so both sides share them.
 */
export const PRECACHE_FILE_EXTENSIONS = ['js', 'wasm', 'css', 'html'] as const;

export const PRECACHE_GLOB_PATTERNS: string[] = [`**/*.{${PRECACHE_FILE_EXTENSIONS.join(',')}}`];

// Large optional resources are fetched only when their feature is used: local
// voice inference, and the video encoder that shrinks a video before it uploads
// (`vite.config.ts` puts it under assets/media-compression/).
export const PRECACHE_EXCLUDED_PREFIXES = ['local-text-voice/', 'local-speech-recognition/', 'assets/media-compression/'];
