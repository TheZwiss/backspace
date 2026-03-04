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
