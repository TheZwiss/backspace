import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

setWorkerId(9);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

// Each test gets a fresh tmp dir so tus file I/O stays isolated.
let tmpDir: string;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// Mock heavy media-processing so tests don't need real files / ffmpeg.
vi.mock('../utils/thumbnail.js', () => ({
  generateThumbnail: vi.fn().mockResolvedValue(null),
  isResizableImage: vi.fn().mockReturnValue(false),
  probeImageDimensions: vi.fn().mockResolvedValue(null),
  probeMediaMeta: vi.fn().mockResolvedValue(null),
  generateVideoThumbnail: vi.fn().mockResolvedValue(null),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

// Override config paths to use the test-local tmpDir so tus file I/O is isolated.
// We do this by mocking the config module.
vi.mock('../config.js', async () => {
  // Grab the real config first (runs dotenv so JWT_SECRET etc. are set)
  const real = await import('../config.js');
  // We'll patch the directory fields; the proxy below reads `tmpDir` at
  // call time, which is reassigned in each beforeEach.
  return {
    config: new Proxy(real.config, {
      get(target, prop: string) {
        if (prop === 'uploadDir') return tmpDir ?? target.uploadDir;
        if (prop === 'tusUploadDir') return tmpDir ? path.join(tmpDir, '.tus') : target.tusUploadDir;
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

async function buildApp(): Promise<FastifyInstance> {
  const { filesRoutes } = await import('./files.js');
  const f = Fastify();
  await f.register(filesRoutes);
  return f;
}

const USER_A_ID = 'user-a';
const USER_B_ID = 'user-b';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-tus-test-'));

  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // Seed instance_settings (ensureDefaults equivalent)
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    updatedAt: Date.now(),
    maxUploadSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB default for most tests
  }).run();

  // Seed two users for ownership tests
  testDb.insert(schema.users).values([
    { id: USER_A_ID, username: 'user_a', passwordHash: 'x', isAdmin: 0, createdAt: Date.now() },
    { id: USER_B_ID, username: 'user_b', passwordHash: 'x', isAdmin: 0, createdAt: Date.now() },
  ]).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  // FileStore.checkOrCreateDirectory() fires an async fs.mkdir in its
  // constructor callback. Deleting the tree before that callback resolves
  // causes an ENOENT uncaught error. We drain one I/O tick to let the
  // callback settle (it will see EEXIST and be ignored), then clean up.
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helper: build a tus-compatible Upload-Metadata header ──────────────────
function tusMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
    .join(',');
}

describe('POST /api/files — tus upload endpoint', () => {
  it('unauthenticated POST returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'tus-resumable': '1.0.0',
        'upload-length': '1024',
        'content-length': '0',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('authenticated create returns 201 + Location + Upload-Expires', async () => {
    const token = signJwt({ userId: USER_A_ID, username: 'user_a' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-length': '512',
        'upload-metadata': tusMetadata({ originalName: 'test.png' }),
        'content-length': '0',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['location']).toBeTruthy();
    expect(res.headers['upload-expires']).toBeTruthy();
  });

  it('non-owner PATCH returns 403', async () => {
    const tokenA = signJwt({ userId: USER_A_ID, username: 'user_a' });
    const tokenB = signJwt({ userId: USER_B_ID, username: 'user_b' });

    // User A creates the upload
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${tokenA}`,
        'tus-resumable': '1.0.0',
        'upload-length': '4',
        'upload-metadata': tusMetadata({ originalName: 'secret.txt' }),
        'content-length': '0',
      },
    });
    expect(createRes.statusCode).toBe(201);

    const location = createRes.headers['location'] as string;
    // Extract the upload ID path from the full Location URL
    const uploadPath = location.replace(/^https?:\/\/[^/]+/, '');

    // User B tries to PATCH — must be rejected
    const patchRes = await app.inject({
      method: 'PATCH',
      url: uploadPath,
      headers: {
        'authorization': `Bearer ${tokenB}`,
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
        'content-type': 'application/offset+octet-stream',
        'content-length': '4',
      },
      payload: Buffer.from('data'),
    });
    expect(patchRes.statusCode).toBe(403);
  });

  it('rejects DELETE from a non-owner with 403', async () => {
    const tokenA = signJwt({ userId: USER_A_ID, username: 'user_a' });
    const tokenB = signJwt({ userId: USER_B_ID, username: 'user_b' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${tokenA}`,
        'tus-resumable': '1.0.0',
        'upload-length': '8',
        'upload-metadata': tusMetadata({ originalName: 'mine.txt' }),
        'content-length': '0',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const uploadPath = (createRes.headers['location'] as string).replace(/^https?:\/\/[^/]+/, '');

    const delRes = await app.inject({
      method: 'DELETE',
      url: uploadPath,
      headers: {
        'authorization': `Bearer ${tokenB}`,
        'tus-resumable': '1.0.0',
      },
    });
    expect(delRes.statusCode).toBe(403);
  });

  it('rejects HEAD from a non-owner with 403', async () => {
    const tokenA = signJwt({ userId: USER_A_ID, username: 'user_a' });
    const tokenB = signJwt({ userId: USER_B_ID, username: 'user_b' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${tokenA}`,
        'tus-resumable': '1.0.0',
        'upload-length': '8',
        'upload-metadata': tusMetadata({ originalName: 'mine.txt' }),
        'content-length': '0',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const uploadPath = (createRes.headers['location'] as string).replace(/^https?:\/\/[^/]+/, '');

    const headRes = await app.inject({
      method: 'HEAD',
      url: uploadPath,
      headers: {
        'authorization': `Bearer ${tokenB}`,
        'tus-resumable': '1.0.0',
      },
    });
    expect(headRes.statusCode).toBe(403);
  });

  it('rejects requests from a soft-deleted user', async () => {
    const token = signJwt({ userId: USER_A_ID, username: 'user_a' });

    // Mark user A as soft-deleted AFTER signing the token.
    testDb.update(schema.users)
      .set({ isDeleted: 1 })
      .where(eq(schema.users.id, USER_A_ID))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-length': '4',
        'upload-metadata': tusMetadata({ originalName: 'x.bin' }),
        'content-length': '0',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens issued before the user's password was changed", async () => {
    // Sign a token with iat = T1 (1000s ago).
    const t1 = Math.floor(Date.now() / 1000) - 1000;
    const { config } = await import('../config.js');
    const token = jwt.sign(
      { userId: USER_A_ID, username: 'user_a', iat: t1 },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '7d' },
    );

    // Set passwordChangedAt to T2 (500s ago) in milliseconds — newer than iat.
    const t2Ms = (Math.floor(Date.now() / 1000) - 500) * 1000;
    testDb.update(schema.users)
      .set({ passwordChangedAt: t2Ms })
      .where(eq(schema.users.id, USER_A_ID))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-length': '4',
        'upload-metadata': tusMetadata({ originalName: 'x.bin' }),
        'content-length': '0',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('completes an upload end-to-end and returns Attachment JSON in final PATCH response', async () => {
    const token = signJwt({ userId: USER_A_ID, username: 'user_a' });
    const body = Buffer.from('hello world\n'); // 12 bytes

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-length': String(body.length),
        'upload-metadata': tusMetadata({ originalName: 'greeting.txt' }),
        'content-length': '0',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const uploadPath = (createRes.headers['location'] as string).replace(/^https?:\/\/[^/]+/, '');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: uploadPath,
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-offset': '0',
        'content-type': 'application/offset+octet-stream',
        'content-length': String(body.length),
      },
      payload: body,
    });
    // tus returns 204 from the underlying handler, but onUploadFinish overrides
    // with a 200 + JSON body. Either way the body should contain the Attachment.
    expect([200, 204]).toContain(patchRes.statusCode);
    const json = JSON.parse(patchRes.body) as {
      id: string; filename: string; size: number; mimetype: string;
    };
    expect(json.id).toBeTruthy();
    expect(json.size).toBe(body.length);
    expect(json.mimetype).toBe('application/octet-stream'); // .txt isn't in EXT_MIMETYPES
    expect(json.filename.endsWith('.txt')).toBe(true);

    // The attachments row should exist in the DB.
    const row = testDb
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, json.id))
      .get();
    expect(row).toBeTruthy();
    expect(row?.size).toBe(body.length);
    expect(row?.uploaderId).toBe(USER_A_ID);

    // The committed file should exist in the upload dir.
    expect(fs.existsSync(path.join(tmpDir, json.filename))).toBe(true);
  });

  it('oversize Upload-Length returns 413', async () => {
    // Set the instance limit to a small value
    testDb.update(schema.instanceSettings)
      .set({ maxUploadSizeBytes: 1024 }) // 1 KB limit
      .run();

    const token = signJwt({ userId: USER_A_ID, username: 'user_a' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'authorization': `Bearer ${token}`,
        'tus-resumable': '1.0.0',
        'upload-length': String(10 * 1024 * 1024 * 1024), // 10 GB > 1 KB
        'upload-metadata': tusMetadata({ originalName: 'huge.bin' }),
        'content-length': '0',
      },
    });
    expect(res.statusCode).toBe(413);
  });
});
