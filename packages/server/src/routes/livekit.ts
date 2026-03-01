import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { authenticate } from '../utils/auth.js';
import { config } from '../config.js';
import { getChannelServerId, hasPermission, isDmMember, PermissionBits } from '../utils/permissions.js';
import type { LiveKitTokenRequest, LiveKitTokenResponse } from '@backspace/shared';

export async function livekitRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LiveKitTokenRequest & { dmChannelId?: string } }>('/api/livekit/token', {
    preHandler: authenticate,
  }, async (request, reply) => {
    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      return reply.code(503).send({ error: 'Voice/video is not configured on this server', statusCode: 503 });
    }

    const { channelId, dmChannelId } = request.body as { channelId?: string; dmChannelId?: string };

    // Determine room name based on channel type
    let roomName: string;

    if (dmChannelId && typeof dmChannelId === 'string') {
      // DM call token
      if (!isDmMember(dmChannelId, request.userId)) {
        return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
      }
      roomName = `dm-${dmChannelId}`;
    } else if (channelId && typeof channelId === 'string') {
      // Server voice channel token
      const serverId = getChannelServerId(channelId);
      if (!serverId) {
        return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
      }
      if (!hasPermission(request.userId, serverId, PermissionBits.CONNECT, channelId)) {
        return reply.code(403).send({ error: 'Missing CONNECT permission', statusCode: 403 });
      }
      roomName = channelId;
    } else {
      return reply.code(400).send({ error: 'channelId or dmChannelId is required', statusCode: 400 });
    }

    const identity = `${request.userId}:${request.username}`;

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      ttl: '1h',
    });

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    const requestHost = request.headers.host?.replace(/:\d+$/, '') || '';
    const livekitUrl = requestHost
      ? `wss://${requestHost}/livekit`
      : (config.livekit.url ?? '');

    const response: LiveKitTokenResponse = {
      token: jwt,
      url: livekitUrl
    };
    return reply.code(200).send(response);
  });
}
