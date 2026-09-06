/**
 * The page served at `/`. Anyone who finds this hostname in a firewall log or
 * in the source should be able to read, on the page itself, what it collects
 * and how long it keeps it. Plain HTML with inline CSS: no fonts, no scripts,
 * no third party requests, so reading it costs the reader nothing.
 */
export const ROOT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Backspace usage pings</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a23; background: #faf9f7; }
h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
code { background: rgba(0, 0, 0, 0.07); padding: 0 0.2rem; border-radius: 3px; }
a { color: #2f6f5e; }
@media (prefers-color-scheme: dark) {
  body { color: #e7e5e4; background: #13131a; }
  code { background: rgba(255, 255, 255, 0.09); }
  a { color: #a7d7c5; }
}
</style>
</head><body>
<h1>Backspace usage pings</h1>
<p>I am Jannis, I maintain <a href="https://github.com/TheZwiss/backspace">Backspace</a>. This address receives the optional daily usage report that an admin of a Backspace server can switch on. It arrives as one <code>POST /v1/ping</code> per day. It is off on every instance until somebody turns it on, and switching it off stops it for good.</p>
<p>One report carries a random id for the instance, the day, the Backspace version, and counts rounded to two significant digits: registered and active users, users per client kind, spaces, channels, messages, stored megabytes, whether voice and federation are on, and how many peers the instance has. I add the country of the request as Cloudflare reports it, because the request reaches me through Cloudflare either way and the country is the one thing I would like to know that the instance itself cannot tell me.</p>
<p>What a report never carries: your domain, the name of your instance, any user name, any e-mail address, any message, any file name, your federation instance id, and any timestamp finer than a calendar day. I do not store the address the request came from. It is used once, as the key of the rate limiter, and never written down.</p>
<p>I delete every row 90 days after its day. What gets published is the aggregate over all instances, never a single instance, on the project's insights page.</p>
<p>The exact payload, the code that builds it and the reason each field is in it: <a href="https://github.com/TheZwiss/backspace/blob/main/docs/systems/telemetry.md">docs/systems/telemetry.md</a>. The source of this receiver: <a href="https://github.com/TheZwiss/backspace/tree/main/scripts/telemetry-receiver">scripts/telemetry-receiver</a>.</p>
</body></html>`;
