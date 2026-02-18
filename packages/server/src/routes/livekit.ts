import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { authenticate } from '../utils/auth.js';
import { config } from '../config.js';
import { getChannelServerId, isMember } from '../utils/permissions.js';
import type { LiveKitTokenRequest, LiveKitTokenResponse } from '@opencord/shared';

export async function livekitRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LiveKitTokenRequest }>('/api/livekit/token', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { channelId } = request.body;

    if (!channelId || typeof channelId !== 'string') {
      return reply.code(400).send({ error: 'channelId is required', statusCode: 400 });
    }

    const serverId = getChannelServerId(channelId);
    if (!serverId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!isMember(serverId, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    const identity = `${request.userId}:${request.username}`;

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      ttl: '1h',
    });

    token.addGrant({
      room: channelId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    const response: LiveKitTokenResponse = { token: jwt };
    return reply.code(200).send(response);
  });
}
