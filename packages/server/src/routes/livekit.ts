import type { FastifyInstance } from 'fastify';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { config } from '../config.js';
import { getChannelSpaceId, hasPermission, computePermissions, isDmMember, PermissionBits } from '../utils/permissions.js';
import type { LiveKitTokenRequest, LiveKitTokenResponse } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Generate a LiveKit token for a federated call participant.
 * Uses homeUserId as identity (stable across instances).
 * Short TTL (5 min) — must join quickly.
 */
export async function generateFederatedCallToken(
  roomName: string,
  homeUserId: string,
  displayName: string,
): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey!, config.livekit.apiSecret!, {
    identity: `${homeUserId}:${displayName}`,
    ttl: '5m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}

export async function livekitRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LiveKitTokenRequest & { dmChannelId?: string } }>('/api/livekit/token', {
    preHandler: authenticate,
  }, async (request, reply) => {
    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      return sendError(reply, 503, 'voice_disabled');
    }

    const { channelId, dmChannelId } = request.body as { channelId?: string; dmChannelId?: string };

    // Determine room name based on channel type
    let roomName: string;

    // Default: full publish (DM calls always get full permissions)
    let canSpeak = true;
    let canStream = true;

    if (dmChannelId && typeof dmChannelId === 'string') {
      // DM call token
      if (!isDmMember(dmChannelId, request.userId)) {
        return sendError(reply, 403, 'not_dm_member');
      }

      // Federated DMs use federatedId as room name (cross-instance stable).
      // Local-only DMs use dm-{dmChannelId}.
      const db = getDb();
      const channel = db.select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels)
        .where(eq(schema.dmChannels.id, dmChannelId))
        .get();

      roomName = channel?.federatedId ? channel.federatedId : `dm-${dmChannelId}`;
    } else if (channelId && typeof channelId === 'string') {
      // Space voice channel token
      const spaceId = getChannelSpaceId(channelId);
      if (!spaceId) {
        return sendError(reply, 404, 'channel_not_found');
      }
      if (!hasPermission(request.userId, spaceId, PermissionBits.CONNECT, channelId)) {
        return sendError(reply, 403, 'voice_connect_forbidden');
      }
      // Check SPEAK and STREAM permissions for granular token grants
      const perms = computePermissions(request.userId, spaceId, channelId);
      canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      canStream = (perms & PermissionBits.STREAM) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      roomName = channelId;
    } else {
      return sendError(reply, 400, 'validation_failed');
    }

    const identity = `${request.userId}:${request.username}`;

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      ttl: '1h',
    });

    // Build canPublishSources based on permissions
    const canPublishSources: TrackSource[] = [];
    if (canSpeak) {
      canPublishSources.push(TrackSource.MICROPHONE);
      canPublishSources.push(TrackSource.CAMERA);
    }
    if (canStream) {
      canPublishSources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    }

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: canSpeak || canStream,
      canPublishSources,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    const livekitUrl = config.livekit.url ?? '';

    const response: LiveKitTokenResponse = {
      token: jwt,
      url: livekitUrl
    };
    return reply.code(200).send(response);
  });
}
