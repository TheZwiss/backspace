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

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://nova.ddns.net/livekit';
const API_KEY = process.env.LIVEKIT_API_KEY || 'REDACTED_LIVEKIT_KEY';
const API_SECRET = process.env.LIVEKIT_API_SECRET || 'REDACTED_LIVEKIT_SECRET';

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
  // The LiveKit server runs on the Pi at 192.168.1.10:7880 (host network mode).
  // The DDNS domain (nova.ddns.net) routes externally but may not loop back on LAN.
  // Try the LAN address first, then fall back to the configured URL.
  const lanUrl = 'http://192.168.1.10:7880';
  const wanUrl = LIVEKIT_URL.replace('wss://', 'https://').replace('ws://', 'http://');

  let roomService: RoomServiceClient;
  let usedUrl: string;
  try {
    roomService = new RoomServiceClient(lanUrl, API_KEY, API_SECRET);
    const rooms = await roomService.listRooms();
    usedUrl = lanUrl;
    console.log(`  Server responded via LAN (${lanUrl}). Active rooms: ${rooms.length}`);
    for (const room of rooms) {
      console.log(`    - ${room.name} (${room.numParticipants} participants)`);
    }
  } catch {
    console.log(`  LAN address unreachable, trying WAN (${wanUrl})...`);
    roomService = new RoomServiceClient(wanUrl, API_KEY, API_SECRET);
    const rooms = await roomService.listRooms();
    usedUrl = wanUrl;
    console.log(`  Server responded via WAN (${wanUrl}). Active rooms: ${rooms.length}`);
    for (const room of rooms) {
      console.log(`    - ${room.name} (${room.numParticipants} participants)`);
    }
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
