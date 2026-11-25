import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

type TrustProxy = (address: string, hop: number) => boolean;

function parseRule(rule: string): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  const [address = '', rawPrefix, extra] = rule.split('/');
  const family = isIP(address);
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? maxPrefix : Number(rawPrefix);
  if (!family || address.includes('%') || extra !== undefined ||
      (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) ||
      prefix < 1 || prefix > maxPrefix) {
    throw new Error(`Invalid TRUSTED_PROXY_ADDRESSES entry ${JSON.stringify(rule)}. Use a proxy IP address or an explicit IPv4/IPv6 CIDR.`);
  }

  const network = ipaddr.parse(address);
  if (network instanceof ipaddr.IPv6 && network.isIPv4MappedAddress()) {
    if (prefix <= 96) {
      throw new Error(`Invalid TRUSTED_PROXY_ADDRESSES entry ${JSON.stringify(rule)}. An IPv4-mapped IPv6 prefix must be longer than /96.`);
    }
    return [network.toIPv4Address(), prefix - 96];
  }
  return [network, prefix];
}

export function buildTrustProxy(hops: number, addresses: string | undefined): false | TrustProxy {
  if (hops === 0) return false;
  if (!addresses?.trim()) {
    throw new Error(
      'TRUSTED_PROXY_ADDRESSES is required for proxy forwarding. Set it to the IP addresses or CIDRs of your proxies, including the peer Backspace actually sees. ' +
      'Bundled Caddy Compose sets this automatically. Set TRUSTED_PROXY_HOPS=0 for direct access. See docs/systems/deployment.md.'
    );
  }

  const rules = addresses.split(',').map((rule) => parseRule(rule.trim()));
  return (address, hop) => {
    if (hop >= hops || !isIP(address)) return false;
    const peer = ipaddr.process(address);
    return rules.some(([network, prefix]) => peer.kind() === network.kind() && peer.match(network, prefix));
  };
}
