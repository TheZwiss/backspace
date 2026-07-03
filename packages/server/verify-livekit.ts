/**
 * LiveKit Verification Script
 *
 * Proves that:
 * 1. Environment variables load correctly
 * 2. AccessToken generates a valid JWT
 * 3. The LiveKit server is reachable and accepts our credentials
 *
 * Run: npx tsx packages/server/verify-livekit.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../../.env') });

// All values come from the environment (loaded from .env above). Never hardcode
// credentials, hostnames, or LAN addresses here — this script ships in the repo.
const env = {
  url: process.env.LIVEKIT_URL,
  apiKey: process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET,
};

const missing = (['url', 'apiKey', 'apiSecret'] as const)
  .filter((k) => !env[k])
  .map((k) => ({ url: 'LIVEKIT_URL', apiKey: 'LIVEKIT_API_KEY', apiSecret: 'LIVEKIT_API_SECRET' }[k]));

if (missing.length > 0) {
  console.error('LIVEKIT VERIFICATION FAILED');
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Set them in packages/server/.env (or the process environment) and re-run.');
  process.exit(1);
}

// Narrowed to string: guaranteed present past the guard above.
const LIVEKIT_URL = env.url as string;
const API_KEY = env.apiKey as string;
const API_SECRET = env.apiSecret as string;
// Optional: a LAN-local LiveKit URL to try first (e.g. http://10.0.0.5:7880),
// useful when the public domain does not hairpin on the local network.
const LIVEKIT_LAN_URL = process.env.LIVEKIT_LAN_URL;

async function verify() {
  console.log('=== LiveKit Verification ===');
  console.log(`URL:     ${LIVEKIT_URL}`);
  console.log(`API Key: ${API_KEY}`);
  console.log(`Secret:  ${API_SECRET.slice(0, 4)}...${API_SECRET.slice(-4)}`);
  console.log('');

  // Step 1: Generate a token
  console.log('[1/3] Generating AccessToken...');
  const token = new AccessToken(API_KEY, API_SECRET, {
    identity: 'verify-user:verifier',
    ttl: '5m',
  });
  token.addGrant({
    room: 'verification-room',
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const jwt = await token.toJwt();
  console.log(`  Token generated (${jwt.length} chars): ${jwt.slice(0, 40)}...`);
  console.log('  ✓ Token generation works');
  console.log('');

  // Step 2: Decode and validate the JWT structure
  console.log('[2/3] Validating JWT structure...');
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid JWT structure: expected 3 parts, got ${parts.length}`);
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  console.log(`  sub (identity): ${payload.sub}`);
  console.log(`  video grants:   ${JSON.stringify(payload.video)}`);
  if (payload.video?.room !== 'verification-room') {
    throw new Error(`Room grant mismatch: expected "verification-room", got "${payload.video?.room}"`);
  }
  if (!payload.video?.roomJoin) {
    throw new Error('roomJoin grant is missing or false');
  }
  console.log('  ✓ JWT payload is valid');
  console.log('');

  // Step 3: Connect to LiveKit server via RoomServiceClient
  console.log('[3/3] Connecting to LiveKit server...');
  // Convert the configured ws(s):// URL to its http(s):// form for the REST client.
  const wanUrl = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
  // Optionally try a LAN-local address first (set LIVEKIT_LAN_URL) — useful when
  // the public domain does not hairpin back to the host on the local network.
  const candidates = [LIVEKIT_LAN_URL, wanUrl].filter((u): u is string => Boolean(u));

  let usedUrl = '';
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const roomService = new RoomServiceClient(candidate, API_KEY, API_SECRET);
      const rooms = await roomService.listRooms();
      usedUrl = candidate;
      console.log(`  Server responded via ${candidate}. Active rooms: ${rooms.length}`);
      for (const room of rooms) {
        console.log(`    - ${room.name} (${room.numParticipants} participants)`);
      }
      break;
    } catch (err) {
      lastError = err;
      console.log(`  ${candidate} unreachable${candidates.length > 1 ? ', trying next…' : ''}`);
    }
  }
  if (!usedUrl) {
    throw new Error(
      `Could not reach the LiveKit server at any of: ${candidates.join(', ')}`,
      { cause: lastError },
    );
  }
  console.log(`  ✓ LiveKit server is reachable at ${usedUrl} and credentials are valid`);
  console.log('');

  // Step 4: Verify the WSS proxy endpoint specifically
  console.log('[4/4] Verifying WSS proxy endpoint (the path browsers use)...');
  const wssProxyUrl = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');
  try {
    const wssService = new RoomServiceClient(wssProxyUrl, API_KEY, API_SECRET);
    const wssRooms = await wssService.listRooms();
    console.log(`  WSS proxy (${wssProxyUrl}) responded. Active rooms: ${wssRooms.length}`);
    console.log('  ✓ WSS proxy is working — browsers can reach LiveKit');
  } catch (wssErr) {
    console.log(`  WSS proxy (${wssProxyUrl}) failed: ${wssErr instanceof Error ? wssErr.message : wssErr}`);
    console.log('  ⚠ WSS proxy is down, but LAN direct access works. Browsers may fail if they resolve to the external IP.');
  }
  console.log('');

  console.log('LIVEKIT VERIFICATION SUCCESS');
}

verify().catch((err) => {
  console.error('');
  console.error('LIVEKIT VERIFICATION FAILED');
  console.error(`Error: ${err.message}`);
  if (err.cause) console.error(`Cause: ${err.cause}`);
  process.exit(1);
});
