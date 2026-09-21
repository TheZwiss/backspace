/**
 * Content hashes for the diff writes in `store.ts`. The hub never merges: a
 * fetched document either matches what is stored, hash for hash, or its rows
 * are compared one by one and only the differing ones are written. Both
 * comparisons rest on the hashes here being a function of the content alone,
 * so the JSON that is hashed has a fixed key order and a fixed `spaces` order
 * whatever order the instance, `JSON.parse` or `parseDocument` produced.
 *
 * See section 7 of docs/superpowers/specs/2026-09-21-space-directory-design.md,
 * ping step 7.
 */

import type { ValidDocument, ValidSpace } from './validate';

const encoder = new TextEncoder();

/** SHA-256 of `text`, lowercase hex. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A copy of `space` whose keys are in the one order every hash uses:
 * `id, name, description, icon, banner, avatarColor, visibility, memberCount,
 * createdAt`. `JSON.stringify` writes keys in insertion order, so the order
 * the caller built its object in must not leak into the hash.
 */
function canonicalSpace(space: ValidSpace): ValidSpace {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    icon: space.icon,
    banner: space.banner,
    avatarColor: space.avatarColor,
    visibility: space.visibility,
    memberCount: space.memberCount,
    createdAt: space.createdAt,
  };
}

/** Code-unit order on `id`, the same on every runtime; `localeCompare` is not. */
function byId(a: ValidSpace, b: ValidSpace): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** SHA-256 hex of one space's fields, the value stored in `spaces.row_hash`. */
export function rowHash(space: ValidSpace): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalSpace(space)));
}

/**
 * SHA-256 hex of the whole validated document, the value stored in
 * `origins.document_hash`. The instance fields come first in a fixed order,
 * then `spaces` sorted by `id` with each space canonicalised, so the same
 * content always hashes the same and any change to any served field changes
 * the hash.
 */
export function documentHash(doc: ValidDocument): Promise<string> {
  const canonical: ValidDocument = {
    instanceName: doc.instanceName,
    federatedRegistrationOpen: doc.federatedRegistrationOpen,
    version: doc.version,
    spaces: doc.spaces.map(canonicalSpace).sort(byId),
  };
  return sha256Hex(JSON.stringify(canonical));
}
