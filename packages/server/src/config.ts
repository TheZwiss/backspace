import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenvConfig({ path: resolve(__dirname, '../../../.env') });

function env(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

function envInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${value}`);
  }
  return parsed;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

export const config = {
  port: envInt('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  jwtSecret: env('JWT_SECRET'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '30d'),
  domain: envOptional('DOMAIN'),

  livekit: {
    url: envOptional('LIVEKIT_URL'),
    apiKey: envOptional('LIVEKIT_API_KEY'),
    apiSecret: envOptional('LIVEKIT_API_SECRET'),
  },

  uploadDir: env('UPLOAD_DIR', resolve(__dirname, '../../../data/uploads')),
  tusUploadDir: resolve(env('UPLOAD_DIR', resolve(__dirname, '../../../data/uploads')), '.tus'),
  tusExpirationMs: envInt('TUS_EXPIRATION_HOURS', 24) * 60 * 60 * 1000,
  tusStragglerSweepMs: envInt('TUS_STRAGGLER_SWEEP_HOURS', 48) * 60 * 60 * 1000,
  dbPath: env('DB_PATH', resolve(__dirname, '../../../data/backspace.db')),
  maxUploadSize: envInt('MAX_UPLOAD_SIZE', 104857600),
  registrationOpen: envBool('REGISTRATION_OPEN', true),
} as const;

if (config.jwtSecret.length < 32) {
  throw new Error(
    `JWT_SECRET must be at least 32 characters (got ${config.jwtSecret.length}). ` +
    `Generate one with: openssl rand -hex 32`
  );
}
