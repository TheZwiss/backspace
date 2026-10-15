import { lookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestText } from '@backspace/translation';
import { publicProviderLookup, serverProviderFetch, serverProviderUrl } from './providerFetch.js';

vi.mock('node:dns', async importOriginal => ({ ...await importOriginal<typeof import('node:dns')>(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
// Select the all-address overload actually used by the socket boundary.
const lookupMock = vi.mocked(lookup as (host: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void);
beforeEach(() => vi.clearAllMocks());

describe('translation outbound boundary', () => {
  it.each([
    'http://example.com', 'https://user:secret@example.com', 'https://example.com/#secret',
    'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]',
    'https://[::ffff:127.0.0.1]', 'https://10.0.0.1', 'https://169.254.169.254', 'https://[fd00::1]',
  ])('rejects unsafe URL %s before opening any socket', async url => {
    await expect(serverProviderFetch(url)).rejects.toMatchObject({ code: 'unsafe-endpoint' });
    expect(request).not.toHaveBeenCalled();
  });
  it('allows public HTTPS endpoints', () => {
    expect(serverProviderUrl('https://api.example.com/v1').hostname).toBe('api.example.com');
  });
  it.each([
    [], [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
  ].map(addresses => ({ addresses })))('rejects empty/private/mixed DNS answers at socket lookup', ({ addresses }) => {
    lookupMock.mockImplementation((_host, _options, callback) => callback(null, addresses));
    const callback = vi.fn();
    publicProviderLookup('api.example.com', { all: true }, callback);
    expect(callback.mock.calls[0]![0]).toMatchObject({ code: 'unsafe-endpoint' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('passes the verified addresses directly to the connecting socket', () => {
    const addresses = [{ address: '8.8.8.8', family: 4 }];
    lookupMock.mockImplementation((_host, _options, callback) => callback(null, addresses));
    const callback = vi.fn();
    publicProviderLookup('api.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
    publicProviderLookup('api.example.com', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '8.8.8.8', 4);
  });
  it('does not replace DNS errors with a success path', () => {
    const failure = new Error('DNS unavailable');
    lookupMock.mockImplementation((_host, _options, callback) => callback(failure, []));
    const callback = vi.fn();
    publicProviderLookup('api.example.com', {}, callback);
    expect(callback.mock.calls[0]![0]).toBe(failure);
  });
  it('keeps TLS hostname verification, uses the safe lookup, and never follows redirects', async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'https://127.0.0.1/private' } });
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.mocked(request).mockImplementation((_url, _options, callback) => {
      callback!(stream as unknown as import('node:http').IncomingMessage);
      stream.end('redirect');
      return req as unknown as import('node:http').ClientRequest;
    });
    const response = await serverProviderFetch('https://api.example.com/v1', { method: 'POST', body: 'payload' });
    expect(response.status).toBe(302);
    expect(response.body).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(new URL('https://api.example.com/v1'), expect.objectContaining({ lookup: publicProviderLookup, agent: false }), expect.any(Function));
    const options = vi.mocked(request).mock.calls[0]![1];
    expect(options).not.toHaveProperty('rejectUnauthorized');
    expect(req.end).toHaveBeenCalledWith('payload');
  });
  it('rejects nonstandard HTTP status without throwing from the asynchronous response callback', async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 700, headers: {} });
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.mocked(request).mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => callback!(stream as unknown as import('node:http').IncomingMessage));
      return req as unknown as import('node:http').ClientRequest;
    });
    await expect(serverProviderFetch('https://api.example.com/v1')).rejects.toMatchObject({ code: 'invalid-response' });
    expect(stream.destroyed).toBe(true);
  });
  it('streams successful responses through the bounded shared transport', async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.mocked(request).mockImplementation((_url, _options, callback) => {
      callback!(stream as unknown as import('node:http').IncomingMessage);
      stream.end('valid response');
      return req as unknown as import('node:http').ClientRequest;
    });
    await expect(requestText({ url: 'https://api.example.com/v1', fetcher: serverProviderFetch })).resolves.toBe('valid response');
  });
  it('cancels oversized provider bodies without accepting partial output', async () => {
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    const req = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.mocked(request).mockImplementation((_url, _options, callback) => {
      callback!(stream as unknown as import('node:http').IncomingMessage);
      stream.end('oversized');
      return req as unknown as import('node:http').ClientRequest;
    });
    await expect(requestText({ url: 'https://api.example.com/v1', fetcher: serverProviderFetch, maxBytes: 2 })).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
