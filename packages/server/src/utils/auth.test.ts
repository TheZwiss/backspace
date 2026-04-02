import { describe, it, expect, vi } from 'vitest';
import { requireLocalUser } from './auth.js';

function mockRequest(homeInstance: string | null) {
  return { homeInstance } as any;
}

function mockReply() {
  const reply: any = {};
  reply.code = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

describe('requireLocalUser', () => {
  it('passes through for local users (homeInstance is null)', async () => {
    const request = mockRequest(null);
    const reply = mockReply();

    await requireLocalUser(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns 403 for federated users (homeInstance is set)', async () => {
    const request = mockRequest('nova.ddns.net');
    const reply = mockReply();

    await requireLocalUser(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Federated users must use their home instance for DM operations',
      statusCode: 403,
    });
  });
});
