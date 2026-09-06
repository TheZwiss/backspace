import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import { config } from '../config.js';
import { buildTelemetryPayload, payloadContextFromConfig, type PayloadContext } from './payload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const ctx: PayloadContext = {
  today: '2026-09-06', telemetryId: 'id-1', version: '1.1.2', commit: 'abc1234', modified: false,
  voice: true, domainSet: true, registrationOpenDefault: true, installChannel: 'prebuilt',
  os: 'linux', arch: 'arm64', nodeMajor: 20,
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, home_instance, is_deleted, last_active_day, last_client, created_at) VALUES
    ('a', 'a', 'x', NULL, 0, '2026-09-06', 'desktop', 1000),
    ('b', 'b', 'x', NULL, 0, '2026-09-01', NULL, 1000),
    ('c', 'c', 'x', NULL, 0, '2026-08-10', 'mobile', 1000),
    ('d', 'd', 'x', NULL, 1, '2026-09-06', 'web', 1000),
    ('r', 'r', 'x', 'remote.example', 0, '2026-09-06', 'web', 1000)`).run();
  ensureDefaults(db);
  db.prepare('UPDATE instance_settings SET installed_at = ?, registration_open = 0, federation_relay_enabled = 1 WHERE id = 1')
    .run(Date.parse('2026-07-03T12:00:00Z'));
  db.prepare(`INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('s1', 'S', 'a', 1)`).run();
  db.prepare(`INSERT INTO channels (id, space_id, name, type, created_at) VALUES ('c1', 's1', 'general', 'text', 1), ('c2', 's1', 'voice', 'voice', 1)`).run();
  const insertMsg = db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, 'c1', 'a', 'hi', ?)`);
  for (let i = 0; i < 150; i++) insertMsg.run(`m${i}`, Date.parse('2026-09-05T00:00:00Z'));
  insertMsg.run('old', Date.parse('2026-08-01T00:00:00Z'));
  db.prepare(`INSERT INTO attachments (id, message_id, filename, original_name, mimetype, size, source_url, created_at) VALUES
    ('f1', 'm1', 'f1', 'f1', 'image/png', ${3 * 1024 * 1024}, NULL, 1),
    ('f2', 'm1', 'f2', 'f2', 'image/png', ${9 * 1024 * 1024}, 'https://remote.example/x', 1)`).run();
  db.prepare(`INSERT INTO federation_peers (id, origin, hmac_secret, status, created_at) VALUES
    ('p1', 'https://p1.example', 'secret', 'active', 1),
    ('p2', 'https://p2.example', 'secret', 'unreachable', 1)`).run();
});

describe('buildTelemetryPayload', () => {
  it('counts local, non-deleted users and windows by last_active_day', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.users).toEqual({ registered: 3, active1d: 1, active7d: 2, active30d: 3 });
  });

  it('groups active7d users by client with null as web', () => {
    expect(buildTelemetryPayload(db, ctx).clients).toEqual({ web: 1, desktop: 1, mobile: 0 });
  });

  it('counts content with rounding, local attachments only, in MiB', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.content).toEqual({ spaces: 1, channels: 2, messages: 150, messages7d: 150, storageMiB: 3 });
  });

  it('reports features and runtime from the context and the settings row', () => {
    const p = buildTelemetryPayload(db, ctx);
    expect(p.features).toEqual({ voice: true, federation: true, peers: 1, registrationOpen: false });
    expect(p.runtime).toEqual({ install: 'prebuilt', os: 'linux', arch: 'arm64', node: 20 });
    expect(p.build).toEqual({ version: '1.1.2', commit: 'abc1234', modified: false });
    expect(p.installedAt).toBe('2026-07');
    expect(p.schema).toBe(1);
    expect(p.instance).toBe('id-1');
    expect(p.day).toBe('2026-09-06');
  });

  it('rounds large counts to two significant digits', () => {
    const insert = db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, 'c1', 'a', 'x', 1)`);
    for (let i = 0; i < 12200; i++) insert.run(`big${i}`);
    expect(buildTelemetryPayload(db, ctx).content.messages).toBe(12000);
  });

  it('maps an unknown install channel to null and never counts DM messages', () => {
    expect(buildTelemetryPayload(db, { ...ctx, installChannel: undefined }).runtime.install).toBeNull();
    db.prepare(`INSERT INTO dm_channels (id, owner_id, created_at) VALUES ('dm1', 'a', 1)`).run();
    db.prepare(`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES ('dmm1', 'dm1', 'a', 'hi', ?)`)
      .run(Date.parse('2026-09-05T00:00:00Z'));
    const p = buildTelemetryPayload(db, ctx);
    expect(p.content.messages).toBe(150);
    expect(p.content.messages7d).toBe(150);
    expect(p.content.channels).toBe(2);
  });

  it('falls back to the environment default when the settings row leaves registration unset', () => {
    db.prepare('UPDATE instance_settings SET registration_open = NULL WHERE id = 1').run();
    expect(buildTelemetryPayload(db, ctx).features.registrationOpen).toBe(true);
    expect(buildTelemetryPayload(db, { ...ctx, registrationOpenDefault: false }).features.registrationOpen).toBe(false);
  });

  it('reports federation off when the relay is disabled or no domain is set', () => {
    expect(buildTelemetryPayload(db, { ...ctx, domainSet: false }).features.federation).toBe(false);
    db.prepare('UPDATE instance_settings SET federation_relay_enabled = 0 WHERE id = 1').run();
    const p = buildTelemetryPayload(db, ctx);
    expect(p.features.federation).toBe(false);
    expect(p.features.peers).toBe(1);
  });
});

describe('payloadContextFromConfig', () => {
  const base = {
    ...config,
    version: '1.1.2',
    commit: 'abc1234',
    domain: 'chat.example',
    registrationOpen: true,
    sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
    livekit: { url: 'wss://lk.example', apiKey: 'key', apiSecret: 'secret' },
    updates: { ...config.updates, installChannel: 'prebuilt' },
  };

  it('reads the build, feature switches and runtime from the configuration', () => {
    expect(payloadContextFromConfig(base, '2026-09-06', 'id-1')).toEqual({
      today: '2026-09-06',
      telemetryId: 'id-1',
      version: '1.1.2',
      commit: 'abc1234',
      modified: false,
      voice: true,
      domainSet: true,
      registrationOpenDefault: true,
      installChannel: 'prebuilt',
      os: process.platform,
      arch: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]),
    });
  });

  it('marks a build modified when the source offer points somewhere other than upstream', () => {
    const forked = payloadContextFromConfig({ ...base, sourceCodeUrl: 'https://example.invalid/fork' }, '2026-09-06', 'id-1');
    expect(forked.modified).toBe(true);
  });

  it('reports voice off when any livekit credential is missing and domainSet off without a domain', () => {
    const c = payloadContextFromConfig(
      { ...base, domain: undefined, livekit: { ...base.livekit, apiSecret: undefined } },
      '2026-09-06',
      'id-1',
    );
    expect(c.voice).toBe(false);
    expect(c.domainSet).toBe(false);
  });
});

describe('telemetry payload privacy', () => {
  it('carries none of the identifying values held by the instance', () => {
    const sentinels = [
      'sentinel-domain.example',
      'sentinel-username',
      'sentinel-message-body',
      'sentinel-file-name.png',
      'sentinel-federation-instance-id',
      'sentinel-instance-name',
    ];
    db.prepare(`INSERT INTO users (id, username, password_hash, last_active_day, created_at) VALUES ('s', 'sentinel-username', 'x', '2026-09-06', 1000)`).run();
    db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('sm', 'c1', 's', 'sentinel-message-body', 1)`).run();
    db.prepare(`INSERT INTO attachments (id, message_id, filename, original_name, mimetype, size, created_at) VALUES ('sf', 'sm', 'sentinel-file-name.png', 'sentinel-file-name.png', 'image/png', 1024, 1)`).run();
    db.prepare('UPDATE instance_settings SET instance_id = ?, instance_name = ? WHERE id = 1')
      .run('sentinel-federation-instance-id', 'sentinel-instance-name');

    const built = payloadContextFromConfig(
      { ...config, domain: 'sentinel-domain.example' },
      '2026-09-06',
      'id-1',
    );
    const json = JSON.stringify(buildTelemetryPayload(db, built));

    for (const sentinel of sentinels) expect(json).not.toContain(sentinel);
    // No timestamp finer than a day: nothing in the payload carries a clock time.
    expect(json).not.toMatch(/\d{2}:\d{2}/);
  });
});
