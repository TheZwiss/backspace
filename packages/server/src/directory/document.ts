import type Database from 'better-sqlite3';
import type { DirectoryDocument, DirectoryDocumentSpace } from '@backspace/shared';

/** Section 5 of the spec: the document never carries more than this. */
export const DIRECTORY_MAX_SPACES = 200;
export const DIRECTORY_MAX_NAME = 100;
export const DIRECTORY_MAX_DESCRIPTION = 200;

export interface DirectoryDocumentContext {
  /** This instance's public origin, as resolveLocalOrigin() reports it. */
  origin: string;
  /** The running version, config.version. */
  version: string;
}

interface SettingsRow {
  instance_name: string | null;
  federated_registration_open: number;
  discovery_enabled: number;
  directory_enabled: number;
}

interface SpaceRow {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  avatar_color: string | null;
  description: string | null;
  visibility: string;
  created_at: number;
  member_count: number;
}

/**
 * The one asset rule. Every icon and banner in the document is either an
 * absolute URL on this origin or null; the hub rejects anything else, and a
 * single foreign value must never delist the whole document.
 *
 * - null stays null
 * - a value already on this origin is kept
 * - any other absolute URL becomes null (never forwarded)
 * - a rooted path becomes origin + path
 * - a bare filename is an upload
 */
export function absoluteAssetUrl(value: string | null, origin: string): string | null {
  if (value === null) return null;
  if (value.startsWith(`${origin}/`)) return value;
  if (value.startsWith('http://') || value.startsWith('https://')) return null;
  if (value.startsWith('/')) return `${origin}${value}`;
  return `${origin}/api/uploads/${value}`;
}

// The Explore query (routes/explore.ts) with the two extra predicates, so a
// member count here means the same thing it means on the Explore page.
const SPACES_SQL = `
  SELECT s.id, s.name, s.icon, s.banner, s.avatar_color, s.description, s.visibility, s.created_at,
         COUNT(sm.user_id) AS member_count
  FROM spaces s
  LEFT JOIN space_members sm ON sm.space_id = s.id
  WHERE s.visibility IN ('public', 'request')
    AND s.directory_listed = 1
  GROUP BY s.id
  ORDER BY member_count DESC, s.created_at DESC
  LIMIT ?
`;

const SETTINGS_SQL =
  'SELECT instance_name, federated_registration_open, discovery_enabled, directory_enabled FROM instance_settings WHERE id = 1';

function rowToSpace(row: SpaceRow, origin: string): DirectoryDocumentSpace {
  return {
    id: row.id,
    name: row.name.slice(0, DIRECTORY_MAX_NAME),
    description: row.description === null ? null : row.description.slice(0, DIRECTORY_MAX_DESCRIPTION),
    icon: absoluteAssetUrl(row.icon, origin),
    banner: absoluteAssetUrl(row.banner, origin),
    avatarColor: (row.avatar_color as DirectoryDocumentSpace['avatarColor']) ?? null,
    visibility: row.visibility as DirectoryDocumentSpace['visibility'],
    memberCount: row.member_count,
    createdAt: row.created_at,
  };
}

/**
 * Builds the document GET /api/directory/spaces serves. Pure over the
 * database: no caching, no config reads. The envelope is always present;
 * `spaces` is empty when either the directory or discovery is switched off,
 * so a hub fetch of a switched-off instance is a success that clears its rows.
 */
export function buildDirectoryDocument(sqlite: Database.Database, ctx: DirectoryDocumentContext): DirectoryDocument {
  const settings = sqlite.prepare(SETTINGS_SQL).get() as SettingsRow | undefined;

  const document: DirectoryDocument = {
    schema: 1,
    origin: ctx.origin,
    instance: {
      name: settings?.instance_name ?? 'Backspace',
      federatedRegistrationOpen: settings?.federated_registration_open === 1,
      version: ctx.version,
    },
    spaces: [],
  };

  if (!settings || settings.directory_enabled !== 1 || settings.discovery_enabled !== 1) {
    return document;
  }

  const rows = sqlite.prepare(SPACES_SQL).all(DIRECTORY_MAX_SPACES) as SpaceRow[];
  document.spaces = rows.map((row) => rowToSpace(row, ctx.origin));
  return document;
}
