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
  `LIVEKIT_PRORT_ADDRS=wlan0=10.0.1.5/24,tun1=100.113.4.54/32,lo=127.0.0.1/8`
  instead of netlink.
- `turn.go` / `config.go`: adds a plain TURN/TCP listener (`tcp_port`) with
  PROXY protocol support for `tailscale serve`.
- `roommanager.go`: advertises TURN/TCP at the configured port instead of the
  upstream hard-coded 443.
