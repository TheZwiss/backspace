//go:build !android
// +build !android

package anet

import (
	"net"
	"os"
	"strconv"
	"strings"
)

func prortSpec() string { return os.Getenv("LIVEKIT_PRORT_ADDRS") }

type prortEntry struct {
	name string
	cidr string
}

func prortInterfaceExists(name string) bool {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		// Cannot tell; keep the declared interface rather than dropping media.
		return true
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), name+":") {
			return true
		}
	}
	return false
}

func prortEntries(spec string) []prortEntry {
	var out []prortEntry
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, cidr, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		out = append(out, prortEntry{strings.TrimSpace(name), strings.TrimSpace(cidr)})
	}
	return out
}

// Interfaces normally uses RTM_GETLINK over netlink, which PRoot blocks.
// With LIVEKIT_PRORT_ADDRS set we build the list from /sys/class/net instead.
func Interfaces() ([]net.Interface, error) {
	spec := prortSpec()
	if spec == "" {
		return net.Interfaces()
	}
	var ifs []net.Interface
	for i, e := range prortEntries(spec) {
		// Skip an interface that is not present (e.g. Tailscale before the
		// Android VPN comes up). /sys/class/net is not readable under PRoot,
		// so use /proc/net/dev, which is.
		if !prortInterfaceExists(e.name) {
			continue
		}
		ifi := net.Interface{Name: e.name, Index: i + 1, MTU: 1500, Flags: net.FlagUp}
		if e.name == "lo" {
			ifi.Flags = net.FlagUp | net.FlagLoopback
		} else {
			ifi.Flags |= net.FlagRunning
		}
		base := "/sys/class/net/" + e.name
		if b, err := os.ReadFile(base + "/ifindex"); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				ifi.Index = n
			}
		}
		if b, err := os.ReadFile(base + "/mtu"); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				ifi.MTU = n
			}
		}
		ifs = append(ifs, ifi)
	}
	return ifs, nil
}

// InterfaceAddrs normally calls net.InterfaceAddrs (netlink). With the spec
// set, return the declared addresses only.
func InterfaceAddrs() ([]net.Addr, error) {
	spec := prortSpec()
	if spec == "" {
		return net.InterfaceAddrs()
	}
	var addrs []net.Addr
	for _, e := range prortEntries(spec) {
		ip, ipnet, err := net.ParseCIDR(e.cidr)
		if err != nil {
			return nil, err
		}
		ipnet.IP = ip
		addrs = append(addrs, ipnet)
	}
	return addrs, nil
}

// InterfaceAddrsByInterface is what Pion's stdnet calls per interface.
func InterfaceAddrsByInterface(ifi *net.Interface) ([]net.Addr, error) {
	spec := prortSpec()
	if spec == "" {
		return ifi.Addrs()
	}
	for _, e := range prortEntries(spec) {
		if e.name != ifi.Name {
			continue
		}
		ip, ipnet, err := net.ParseCIDR(e.cidr)
		if err != nil {
			return nil, err
		}
		ipnet.IP = ip
		return []net.Addr{ipnet}, nil
	}
	return nil, nil
}

func SetAndroidVersion(version uint) {}
