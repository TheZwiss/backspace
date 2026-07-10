import type { FastifyReply } from 'fastify';
import { buildFederationHeaders, getOurOrigin } from '../../../utils/federationAuth.js';

/**
 * Serialize `payload` as JSON and send it as a `200` response signed with the
 * peer's shared HMAC secret, so the receiving instance can verify authenticity
 * (or trust a fail-closed verdict) of the body it carries.
 *
 * This is the single definition of how this instance signs S2S responses: the
 * body is stringified once and the signature is computed over those exact bytes,
 * which are the bytes sent (Content-Type is set explicitly so Fastify does not
 * re-serialize and desync the signature).
 */
export function sendSignedJson(reply: FastifyReply, payload: unknown, hmacSecret: string): FastifyReply {
  const responseBody = JSON.stringify(payload);
  const sigHeaders = buildFederationHeaders(responseBody, hmacSecret, getOurOrigin());
  reply.headers({
    'X-Federation-Signature': sigHeaders['X-Federation-Signature'],
    'X-Federation-Timestamp': sigHeaders['X-Federation-Timestamp'],
    'X-Federation-Nonce': sigHeaders['X-Federation-Nonce'],
    'Content-Type': 'application/json',
  });
  return reply.code(200).send(responseBody);
}
