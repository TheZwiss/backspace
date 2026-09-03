/**
 * Parse invite input into a code and optional remote origin.
 *
 * Supported formats:
 *   - Bare code:      "a3f1b2c4"
 *   - Full URL:       "https://remote.com/join/a3f1b2c4"
 *   - Qualified code: "a3f1b2c4@remote.com"
 */
export function parseInviteInput(input: string): { code: string; origin?: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Invite code is required');

  // Full URL: starts with http:// or https://
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Invalid invite link');
    }

    // Extract code from /join/{code} path
    const match = parsed.pathname.match(/^\/join\/([^/]+)$/);
    if (!match) {
      throw new Error('Invalid invite link — expected format: https://instance/join/CODE');
    }

    const code = match[1]!;

    // If the URL points at our own instance, treat as a bare code
    if (parsed.origin === window.location.origin) {
      return { code };
    }

    return { code, origin: parsed.origin };
  }

  // Qualified code: CODE@domain (contains @ but no spaces, no protocol)
  if (trimmed.includes('@') && !trimmed.includes(' ')) {
    const atIndex = trimmed.indexOf('@');
    const code = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);

    if (!code || !domain) {
      throw new Error('Invalid invite format — expected: CODE@domain');
    }

    const origin = `https://${domain}`;

    // If it resolves to our own instance, treat as bare code
    try {
      if (new URL(origin).origin === window.location.origin) {
        return { code };
      }
    } catch {
      throw new Error('Invalid domain in invite');
    }

    return { code, origin };
  }

  // Bare code
  return { code: trimmed };
}

/**
 * A bare host with an optional port: a dotted name, an IPv4 address, or a
 * bracketed IPv6 literal. It excludes every character that can move where a
 * URL points once the value is concatenated into one, namely whitespace and
 * the delimiters that start a path, a query, a fragment or a userinfo
 * section. Characters above U+00A0 are allowed so an internationalised domain
 * still works; the URL parser punycodes it.
 */
const BARE_HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[^\s/?#@\\:]+)(?::\d{1,5})?$/;

/**
 * Build the URL that sends a user to their own instance to finish joining a
 * space, or null when the typed domain cannot be used.
 *
 * The domain comes from a text field. Concatenating it into a URL string lets
 * a path, a query, a fragment or a userinfo section decide where the browser
 * actually goes, which is then neither what the user typed nor what the
 * surrounding copy promises. So the value is accepted only as a bare host, and
 * the parsed result is checked against what was asked for. The caller must not
 * navigate when this returns null.
 */
export function buildInstanceJoinUrl(domain: string, qualifiedCode: string): string | null {
  const host = domain.trim();
  if (!host || !BARE_HOST.test(host)) return null;

  const path = `/join/${encodeURIComponent(qualifiedCode)}`;

  let target: URL;
  try {
    target = new URL(`https://${host}${path}`);
  } catch {
    return null;
  }

  // The parser, not the concatenation, is the authority on where this points.
  if (target.protocol !== 'https:') return null;
  if (target.username || target.password) return null;
  if (target.pathname !== path || target.search || target.hash) return null;

  return target.toString();
}
