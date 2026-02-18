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
  jwtSecret: env('JWT_SECRET', 'dev-secret-change-me-in-production-please-use-64-chars-hex-string'),
  jwtExpiresIn: env('JWT_EXPIRES_IN', '30d'),

  livekit: {
    url: env('LIVEKIT_URL', 'wss://nova.ddns.net/livekit'),
    apiKey: env('LIVEKIT_API_KEY', 'REDACTED_LIVEKIT_KEY'),
    apiSecret: env('LIVEKIT_API_SECRET', 'REDACTED_LIVEKIT_SECRET'),
  },

  uploadDir: env('UPLOAD_DIR', resolve(__dirname, '../../../data/uploads')),
  dbPath: env('DB_PATH', resolve(__dirname, '../../../data/opencord.db')),
  maxUploadSize: envInt('MAX_UPLOAD_SIZE', 104857600),
  registrationOpen: envBool('REGISTRATION_OPEN', true),
} as const;
