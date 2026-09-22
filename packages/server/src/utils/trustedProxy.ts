/**
 * How many proxies in front of this app are trusted to have written
 * `X-Forwarded-For`, counted from the app outwards. It is Fastify's
 * `trustProxy` (see `index.ts`), and through it the source of `request.ip`.
 *
 * At 1, `request.ip` is the entry the nearest proxy appended, which is the
 * address that proxy actually saw. Anything a client writes into the header
 * sits further left and is ignored. `true` would trust the whole chain and
 * take the left-most entry, which is whatever the client cared to send.
 *
 * That matters because this address is what every rate limit in the app keys
 * on, the global one and the per-route ones (`docs/systems/api.md`, "Rate
 * limiting") and the hand-written limiter on `POST /federation/peer/accept`,
 * which is unauthenticated first contact. It is also what the request log
 * records as `remoteAddress`.
 *
 * **When an operator changes it.** The number is how many proxies they
 * actually run in front of the app, and 1 covers every deployment this repo
 * ships: the bundled Caddy, an operator's own reverse proxy, a tunnel daemon.
 * A CDN in front of their own proxy is two hops and needs 2, or every client
 * behind that CDN lands in one rate-limit bucket. Nothing in front of the app
 * at all is 0, and that case is not cosmetic: at 1 a lone `X-Forwarded-For`
 * entry cannot be told apart from a proxy's word, so a directly exposed
 * instance left at 1 believes whatever a client sends.
 *
 * Too low is a degradation (everyone behind the nearest proxy shares a
 * bucket); too high is a hole (the key goes back to the client). When in
 * doubt, too low.
 *
 * It is a constant rather than an environment variable because getting it
 * wrong is a security property, not a preference, and because changing it
 * means the deployment's shape changed. See `docs/systems/web-security.md`
 * section 9 and `docs/systems/deployment.md`, "Server proxy-awareness".
 */
export const TRUSTED_PROXY_HOPS = 1;
