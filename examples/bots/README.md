# Bot examples

Zero-dependency Node clients for the Bot API (Node 22 or newer). The reference is `docs/systems/bots.md`.

1. In Settings > Bots create a bot and copy the token (it is shown once).
2. Bring the bot into a space (Settings > Bots, or `POST /api/bots/:id/spaces`) or message it directly.
3. Run an example:

```sh
BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/echo.mjs
```

| File | Behaviour |
|------|-----------|
| `client.mjs` | REST helper and a reconnecting WebSocket loop |
| `echo.mjs` | Repeats direct messages |
| `mention-reply.mjs` | Answers when mentioned (channels, group DMs) and to everything in a 1-on-1 DM |
| `react.mjs` | Reacts to messages containing `!ok` |
| `slash.mjs` | Registers slash commands (`/play`, `/stop`) and answers them |
| `voice.mjs` | The Backspace side of a bot in several voice channels at once (no audio: connect LiveKit where marked) |

What a bot does with an event is the bot's own code. The server sends every event the bot may see, and it does not decide for the bot when it speaks.
