// A minimal Backspace bot client: REST helper plus a WebSocket loop that
// reconnects. Node >= 22, no dependencies.
//
//   BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/echo.mjs

export function createBot({ baseUrl, token }) {
  if (!baseUrl || !token) throw new Error('set BACKSPACE_URL and BOT_TOKEN');
  const http = baseUrl.replace(/\/+$/, '');
  const wsUrl = `${http.replace(/^http/, 'ws')}/ws`;
  let socket = null;
  const bot = { me: null, api, run, send };

  /** REST call. Throws an Error with .status and .body on a non-2xx answer. */
  async function api(method, path, body) {
    const res = await fetch(`${http}/api${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${typeof json === 'string' ? json : json.code ?? json.error}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /** Sends a client event over the open socket; false when there is none. */
  function send(event) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(event));
    return true;
  }

  /** Connects and calls onEvent(event) for every server event. Reconnects forever. */
  function run(onEvent) {
    let attempt = 0;
    const connect = () => {
      const ws = new WebSocket(wsUrl);
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (msg) => {
        let event;
        try { event = JSON.parse(msg.data); } catch { return; }
        if (event.type === 'ready') {
          bot.me = event.user;
          attempt = 0;
          console.log(`connected as ${bot.me.username} (${bot.me.id})`);
        }
        Promise.resolve(onEvent(event)).catch((err) => console.error('handler error:', err.message));
      };
      ws.onclose = () => {
        const wait = Math.min(30_000, 1_000 * 2 ** attempt++);
        console.log(`disconnected, reconnecting in ${wait / 1000}s`);
        setTimeout(connect, wait);
      };
      ws.onerror = () => { /* onclose follows */ };
    };
    connect();
  }

  return bot;
}

/** The mention token of a user. Tokens inside code spans and fenced blocks are not mentions. */
export function mentions(content, userId) {
  const scan = /(```[\s\S]*?```|`[^`]+`)|<@([a-zA-Z0-9_-]+)>/g;
  for (const m of (content ?? '').matchAll(scan)) {
    if (m[2] === userId) return true;
  }
  return false;
}
