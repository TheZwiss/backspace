import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a 256-bit random hex secret for HMAC signing.
 */
export function generateHmacSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute HMAC-SHA256 of `${timestamp}.${body}` using the given secret.
 * Returns a hex-encoded signature string.
 */
export function signRequest(body: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/**
 * Verify a federation request signature.
 *
 * Returns true only if:
 *   - The timestamp is within maxAgeMs of Date.now()
 *   - The HMAC-SHA256 of `${timestamp}.${body}` matches the provided signature
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifySignature(
  body: string,
  signature: string,
  secret: string,
  timestamp: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  // Guard against empty or obviously invalid inputs
  if (!body && body !== '') return false;
  if (!signature || !secret) return false;

  // Validate timestamp is within the acceptable window
  const age = Math.abs(Date.now() - timestamp);
  if (age > maxAgeMs) return false;

  const expected = signRequest(body, secret, timestamp);

  // Convert both to Buffers for constant-time comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

  // timingSafeEqual requires identical lengths; mismatched lengths mean invalid
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Build the HTTP headers required for an outbound federation request.
 *
 * Returned headers:
 *   X-Federation-Signature: sha256=<hmac-hex>
 *   X-Federation-Origin:    <origin>
 *   X-Federation-Timestamp: <unix-ms>
 *   Content-Type:           application/json
 */
export function buildFederationHeaders(
  body: string,
  secret: string,
  origin: string,
): Record<string, string> {
  const timestamp = Date.now();
  const sig = signRequest(body, secret, timestamp);

  return {
    'X-Federation-Signature': `sha256=${sig}`,
    'X-Federation-Origin': origin,
    'X-Federation-Timestamp': String(timestamp),
    'Content-Type': 'application/json',
  };
}

/**
 * Parse and validate the federation headers from an inbound request.
 *
 * Returns the extracted { origin, timestamp, signature } on success,
 * or null if any required header is missing or malformed.
 *
 * Signature header format: `sha256=<hex>`
 */
export function parseFederationHeaders(
  headers: Record<string, string | string[] | undefined>,
): { origin: string; timestamp: number; signature: string } | null {
  // Helper to extract a single string value from a potentially multi-value header
  const getHeader = (name: string): string | null => {
    const value = headers[name];
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
      return value.length > 0 ? (value[0] ?? null) : null;
    }
    return value;
  };

  const rawSignature = getHeader('x-federation-signature') ?? getHeader('X-Federation-Signature');
  const rawOrigin = getHeader('x-federation-origin') ?? getHeader('X-Federation-Origin');
  const rawTimestamp = getHeader('x-federation-timestamp') ?? getHeader('X-Federation-Timestamp');

  if (!rawSignature || !rawOrigin || !rawTimestamp) return null;

  // Signature must be in the format "sha256=<hex>"
  const sigPrefix = 'sha256=';
  if (!rawSignature.startsWith(sigPrefix)) return null;

  const signature = rawSignature.slice(sigPrefix.length);
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return null;

  const timestampMs = Number(rawTimestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

  const origin = rawOrigin.trim();
  if (!origin) return null;

  return { origin, timestamp: timestampMs, signature };
}

/**
 * Return the canonical origin URL for this instance.
 * Uses DOMAIN env var for production, falls back to localhost for dev.
 */
export function getOurOrigin(): string {
  if (config.domain) {
    return `https://${config.domain}`;
  }
  return `http://localhost:${config.port}`;
}
