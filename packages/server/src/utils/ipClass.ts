/**
 * Address classification for outbound-request safety.
 *
 * Pure and I/O-free on purpose: the SSRF path does DNS, which makes its tests
 * slow and dependent on the host resolver. Range membership does not, so it is
 * tested exhaustively here instead.
 *
 * Everything unparseable classifies as 'reserved', never 'public'. A classifier
 * that answers "public" when it does not understand its input is worse than no
 * classifier, because callers treat 'public' as permission.
 */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'cgnat'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

/** Parse dotted-quad IPv4 into four octets. Strict: rejects leading zeros. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Unwrap an IPv4-mapped IPv6 address to its dotted-quad form.
 *
 * Both spellings occur and neither is exotic: the WHATWG URL parser emits the
 * hex form (`::ffff:7f00:1`) while glibc's inet_ntop emits the dotted form
 * (`::ffff:127.0.0.1`). Handling one and not the other leaves the hole open on
 * whichever resolution path you did not test.
 */
function unmapIpv4(ip: string): string | null {
  const match = /^::ffff:([0-9a-f.:]+)$/i.exec(ip);
  if (!match) return null;
  const tail = match[1]!;

  if (tail.includes('.')) {
    return parseIpv4(tail) ? tail : null;
  }

  const groups = tail.split(':');
  if (groups.length < 1 || groups.length > 2) return null;
  const values: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    values.push(Number.parseInt(group, 16));
  }
  // A single group is the low half: `::ffff:1` is 0.0.0.1.
  const [hi, lo] = values.length === 2 ? [values[0]!, values[1]!] : [0, values[0]!];
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

function classifyIpv4(octets: [number, number, number, number]): AddressClass {
  const [a, b] = octets;
  if (a === 0) return octets.every(o => o === 0) ? 'unspecified' : 'reserved';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 192 && b === 0 && octets[2] === 0) return 'reserved';    // IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 2) return 'reserved';    // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';        // benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return 'reserved';  // TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';                                   // includes 255.255.255.255
  return 'public';
}

/** Expand an IPv6 address to its eight 16-bit groups. Returns null if malformed. */
function parseIpv6(ip: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = toGroups(halves[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = toGroups(halves[0]!);
  const tail = toGroups(halves[1]!);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

export function classifyAddress(ip: string): AddressClass {
  if (typeof ip !== 'string' || ip === '') return 'reserved';
  const address = ip.trim().replace(/^\[|\]$/g, '');

  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);

  const mapped = unmapIpv4(address);
  if (mapped) {
    const parsed = parseIpv4(mapped);
    return parsed ? classifyIpv4(parsed) : 'reserved';
  }

  const groups = parseIpv6(address);
  if (!groups) return 'reserved';

  if (groups.every(g => g === 0)) return 'unspecified';
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return 'loopback';

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return 'private';      // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return 'link-local';   // fe80::/10
  if ((first & 0xff00) === 0xff00) return 'multicast';    // ff00::/8
  return 'public';
}

/**
 * The only predicate callers should use. Fails closed: anything that does not
 * classify cleanly as 'public' is refused.
 */
export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === 'public';
}
