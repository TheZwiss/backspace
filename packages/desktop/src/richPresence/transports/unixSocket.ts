import fs from 'fs';
import net from 'net';
import path from 'path';
import { IPC_SLOTS } from '../protocol';
import type {
  RichPresenceEndpoint,
  RichPresenceTransport,
  RichPresenceTransportServer,
} from './types';

export function candidateSocketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  const xdg = env['XDG_RUNTIME_DIR'];
  if (xdg && xdg.trim()) dirs.push(xdg);
  const tmp = env['TMPDIR'] || env['TMP'] || env['TEMP'] || '/tmp';
  if (!dirs.includes(tmp)) dirs.push(tmp);
  return dirs;
}

function probe(address: string, timeoutMs = 400): Promise<'live' | 'stale' | 'free'> {
  return new Promise((resolve) => {
    const client = net.connect(address);
    let settled = false;
    const finish = (result: 'live' | 'stale' | 'free') => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.once('connect', () => finish('live'));
    client.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' ? 'stale' : 'free');
    });
    setTimeout(() => finish('live'), timeoutMs);
  });
}

async function endpointStatus(address: string): Promise<'live' | 'stale' | 'free' | 'occupied'> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(address);
  } catch {
    return 'free';
  }
  if (!stat.isSocket()) return 'occupied';
  const status = await probe(address);
  return status === 'free' ? 'occupied' : status;
}

export class UnixSocketTransport implements RichPresenceTransport {
  readonly kind = 'unix-socket' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async listAvailableEndpoints(): Promise<RichPresenceEndpoint[]> {
    const endpoints: RichPresenceEndpoint[] = [];
    for (const dir of candidateSocketDirs(this.env)) {
      for (const slot of IPC_SLOTS) {
        const address = path.join(dir, `discord-ipc-${slot}`);
        const status = await endpointStatus(address);
        if (status === 'live' || status === 'occupied') continue;
        if (status === 'stale') {
          try {
            fs.unlinkSync(address);
          } catch {
            continue;
          }
        }
        endpoints.push({ id: address, address, kind: this.kind });
      }
    }
    return endpoints;
  }

  async listen(
    endpoint: RichPresenceEndpoint,
    onConnection: (socket: net.Socket) => void,
  ): Promise<RichPresenceTransportServer | null> {
    const server = net.createServer(onConnection);
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(endpoint.address, () => resolve(true));
    });
    if (!listening) {
      server.close();
      return null;
    }
    try {
      fs.chmodSync(endpoint.address, 0o600);
    } catch {
      // Best-effort hardening.
    }
    return {
      endpoint,
      close: () => {
        server.close();
        try {
          fs.unlinkSync(endpoint.address);
        } catch {
          // Already gone.
        }
      },
    };
  }
}
