# PRoot/Android deployment kit

Everything in this directory is a **reproducible copy** of the changes that made
Backspace work on Debian 13 ARM64 under PRoot (Android 11), including voice,
video, screen share and the Electron client.

The primary, zero-CA URL is the Tailscale Serve endpoint:

```
https://backspace.<sua-tailnet>.ts.net
```

`/livekit` is proxied to LiveKit and `/` to the Backspace server. The Tailscale
node `backspace` must be shared (Machines → backspace → Share) with users from
another tailnet. Their media can use the TURN/TCP forward on the same node.

## Contents

| Path | Purpose |
|---|---|
| `caddy/Caddyfile.example` | HTTPS/WSS edge for LAN/Tailscale IPs (optional if using Tailscale Serve) |
| `caddy/generate-cert.sh` | generates a Caddy-CA leaf certificate with LAN/WAN SANs |
| `livekit/livekit.yaml.example` | LiveKit SFU, TURN/UDP, TURN/TCP and relay settings |
| `livekit/*.patch` | exact LiveKit 1.13.11 patches for PRoot/netlink/port 443 |
| `livekit/PATCHES.md` | how to rebuild the patched LiveKit binary |
| `termux/backspace-autostart.sh` | starts the Debian/PRoot stack from Termux |
| `termux/30-backspace` | Termux:Boot entry |
| `../../start-stack.sh` | starts LiveKit, Tailscale userspace/serve, Caddy and Backspace |
| `../../stop-stack.sh` / `status-stack.sh` | stop/check |

## Secrets

Never commit:

- `.env`, `.env.*` (only `.env.example`)
- `livekit.yaml` (only `livekit.yaml.example`)
- `*.crt`, `*.key`, `*.pem`
- `data/` (SQLite and uploads)
- Tailscale auth keys and GitHub tokens

## Termux

Copy `termux/backspace-autostart.sh` to `$HOME` and
`termux/30-backspace` to `$HOME/.termux/boot/`, both mode 700. Opening Termux
also starts the stack through the `.profile` hook. Android boot needs the
**Termux:Boot** app installed and battery optimization disabled for Termux and
Termux:Boot.

Full operational notes: `../../INSTALACAO-ANDROID-PROOT.md`.
