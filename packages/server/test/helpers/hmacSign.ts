import { buildFederationHeaders } from '../../src/utils/federationAuth.js';

/**
 * Wrapper exposed for the malicious-peer test (#13). Builds the same headers
 * production code uses, but lets the test pass an arbitrary X-Federation-Origin.
 */
export function buildHeadersForOrigin(body: string, secret: string, claimedOrigin: string): Record<string, string> {
  return buildFederationHeaders(body, secret, claimedOrigin);
}
