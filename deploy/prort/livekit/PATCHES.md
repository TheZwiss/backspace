# LiveKit 1.13.11 patches for Debian/PRoot on Android

These are the changes needed because PRoot blocks rtnetlink and the Android
kernel does not allow binding ports below 1024.

Apply from the LiveKit v1.13.11 source root:

```bash
patch -p1 < pkg-config-config.go.patch
patch -p1 < pkg-service-turn.go.patch
patch -p1 < pkg-service-roommanager.go.patch
patch -p1 < pkg-telemetry-prometheus-node_linux.go.patch
```

Then patch the two Go modules:

1. `github.com/wlynxg/anet@v0.0.5`:
   ```bash
   go mod download github.com/wlynxg/anet
   cp -a "$(go env GOMODCACHE)/github.com/wlynxg/anet@v0.0.5" /tmp/anet-patched
   patch -p1 -d /tmp/anet-patched < anet-interface.go.patch
   echo 'replace github.com/wlynxg/anet => /tmp/anet-patched' >> go.mod
   ```
   `anet-interface.go` is also included as the complete patched file.

2. `github.com/livekit/protocol@v1.53.1-0.20261023175527-46332a036e25`:
   ```bash
   go mod download github.com/livekit/protocol
   cp -a "$(go env GOMODCACHE)/github.com/livekit/protocol@v1.53.1-0.20261023175527-46332a036e25" /tmp/livekit-protocol
   patch -p1 -d /tmp/livekit-protocol < hwstats-cpu_linux.go.patch
   echo 'replace github.com/livekit/protocol => /tmp/livekit-protocol' >> go.mod
   ```

Build (Go >= 1.26.0):

```bash
GOROOT=/tmp/go PATH=/tmp/go/bin:$PATH GOMAXPROCS=4 CGO_ENABLED=1 \
  /tmp/go/bin/go build -trimpath -buildvcs=false -o livekit-server ./cmd/server
```

What each patch fixes:

- `node_linux.go`: `getTCStats()` returns 0 instead of hanging on rtnetlink.
- `hwstats-cpu_linux.go`: treats denied `/sys/fs/cgroup` lstat as absent.
- `anet-interface.go`: builds interfaces/addresses from
  `LIVEKIT_PRORT_ADDRS=wlan0=192.168.1.10/24,tun1=100.64.0.10/32,lo=127.0.0.1/8`
  instead of netlink.
- `turn.go` / `config.go`: adds a plain TURN/TCP listener (`tcp_port`) with
  PROXY protocol support for `tailscale serve`.
- `roommanager.go`: advertises TURN/TCP at the configured port instead of the
  upstream hard-coded 443.

## Rebuilding automatically: `update-livekit.sh`

Instead of applying the patches by hand, run (as root inside the Debian
container; copy this directory to e.g. `/opt/livekit/patch-kit/` first):

```bash
./update-livekit.sh --check              # is a newer upstream release out?
./update-livekit.sh --build [VERSION]    # download, patch, compile, smoke-test. Installs nothing.
./update-livekit.sh --apply [VERSION]    # --build, then swap the binary and restart LiveKit
./update-livekit.sh --rollback           # restore the previous binary
```

What it does and guarantees:

- Reads the pinned `anet` and `livekit/protocol` versions from the new release's
  `go.mod`, so this file's version numbers no longer need editing per release.
- Dry-runs every patch before changing anything. A patch that no longer applies
  stops the run with its name; nothing live is touched. That is the signal to
  rebase that one patch.
- Uses a private Go module cache (`<LK_DIR>/build/gomodcache`). Patching modules
  inside the shared cache corrupts it (`go mod verify` then reports "dir has been
  modified") and later builds would start from an already-patched file.
- Downloads the exact Go version the release needs into `<LK_DIR>/toolchain`,
  with a completion marker so an interrupted download is redone, not reused.
- Starts the candidate on side ports (17880-17882) and requires it to answer
  before it can be installed. The live server is untouched until `--apply`.
- `--apply` keeps the old binary as `<LK_DIR>/livekit-server.bin.prev`, restarts
  only LiveKit, waits for it to answer on :7880, and restores the old binary by
  itself if it does not. Calls in progress drop for a few seconds.

Run it from an interactive session (or `tmux`). PRoot runs with `--kill-on-exit`,
so a build started with `nohup` over a closing SSH session is killed with it.
A build takes about 5 minutes on a Redmi 9T-class phone.

Validated by rebuilding 1.13.11 (the version in production): the result is
75,072,936 bytes against 75,072,880 for the hand-built binary, and it passes the
smoke test.
