import { IpcSessionManager } from './session';
import {
  createRichPresenceTransport,
  type RichPresenceTransport,
  type RichPresenceTransportServer,
} from './transports';
import type { IpcActivityPush } from './protocol';

export interface RichPresenceIpcServerOptions {
  onActivity: (push: IpcActivityPush | null) => void;
  /** Test seam for simulating a platform transport. */
  transport?: RichPresenceTransport;
}

export interface RichPresenceIpcStatus {
  running: boolean;
  socketCount: number;
  connectionCount: number;
}

let activeServers: RichPresenceTransportServer[] = [];
let sessions: IpcSessionManager | null = null;
let startPromise: Promise<void> | null = null;

export async function startRichPresenceIpcServer(options: RichPresenceIpcServerOptions): Promise<void> {
  if (activeServers.length > 0 || startPromise) {
    if (startPromise) await startPromise;
    return;
  }
  const manager = new IpcSessionManager();
  manager.setOnActivity(options.onActivity);
  sessions = manager;
  const transport = options.transport ?? createRichPresenceTransport();

  startPromise = (async () => {
    const endpoints = await transport.listAvailableEndpoints();
    const listening: RichPresenceTransportServer[] = [];
    for (const endpoint of endpoints) {
      const server = await transport.listen(endpoint, manager.attach);
      if (server) listening.push(server);
    }
    if (listening.length === 0) {
      console.log(`[RichPresenceIpc] No free ${transport.kind} slots — server not started`);
      return;
    }
    activeServers = listening;
    console.log(`[RichPresenceIpc] Listening on ${listening.length} ${transport.kind}(s)`);
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

export function stopRichPresenceIpcServer(): void {
  sessions?.stop();
  sessions = null;
  for (const server of activeServers) server.close();
  activeServers = [];
  startPromise = null;
}

export function getRichPresenceIpcStatus(): RichPresenceIpcStatus {
  return {
    running: activeServers.length > 0,
    socketCount: activeServers.length,
    connectionCount: sessions?.connectionCount() ?? 0,
  };
}
