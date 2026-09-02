import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { CSP_REPORT_PATH } from '../utils/csp.js';

/**
 * Largest report body read off the wire. Reports are diagnostics from untrusted
 * browsers and a violation can be triggered deliberately, so the endpoint must
 * not become a way to write unbounded data into an operator's log. Anything past
 * this is dropped rather than rejected: a browser cannot act on an error and
 * would only retry.
 */
const MAX_REPORT_BYTES = 16_384;

/** Longest string written to the log for a single report. */
const MAX_LOGGED_CHARS = 4_096;

/** Content types browsers use to post policy violations. */
const REPORT_CONTENT_TYPES = ['application/csp-report', 'application/reports+json'];

/**
 * Reads a report body as text, stopping at MAX_REPORT_BYTES.
 *
 * This is the raw-stream form of a Fastify content-type parser, chosen over
 * `{ parseAs: 'string' }` because that form answers 413 once `bodyLimit` is
 * exceeded. A 413 to a browser reporting a violation loses the report entirely,
 * and the interesting part of an oversized report is at the front of it anyway.
 */
function parseReportBody(
  _request: FastifyRequest,
  payload: IncomingMessage,
  done: (err: Error | null, body?: string) => void,
): void {
  let raw = '';
  let truncated = false;
  payload.on('data', (chunk: Buffer | string) => {
    if (truncated) return;
    raw += chunk.toString();
    if (raw.length > MAX_REPORT_BYTES) {
      raw = raw.slice(0, MAX_REPORT_BYTES);
      truncated = true;
    }
  });
  payload.on('end', () => done(null, raw));
  payload.on('error', () => done(null, ''));
}

/**
 * The violation sink for `report-uri` and `report-to`.
 *
 * Unauthenticated on purpose: a policy violation can happen on the login screen,
 * before any token exists, and those are exactly the reports worth having. It
 * answers 204 to everything, including malformed input, because a browser has no
 * use for an error and retrying would only amplify.
 *
 * The content-type parsers are the point of this file. Browsers post CSP reports
 * as `application/csp-report` and Reporting API payloads as
 * `application/reports+json`. Fastify ships parsers for neither and would answer
 * 415, producing an empty log that is indistinguishable from a clean policy.
 */
export async function cspReportRoutes(app: FastifyInstance): Promise<void> {
  for (const contentType of REPORT_CONTENT_TYPES) {
    app.addContentTypeParser(contentType, parseReportBody);
  }

  app.post(CSP_REPORT_PATH, async (request, reply) => {
    const body = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body ?? {});

    let summary: string;
    try {
      const parsed: unknown = JSON.parse(body);
      summary = JSON.stringify(parsed);
    } catch {
      summary = `unparseable: ${body}`;
    }

    request.log.warn(
      { csp: summary.slice(0, MAX_LOGGED_CHARS), userAgent: request.headers['user-agent'] },
      'CSP violation reported',
    );

    return reply.code(204).send();
  });
}
