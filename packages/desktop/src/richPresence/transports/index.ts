import type { RichPresenceTransport } from './types';
import { UnixSocketTransport } from './unixSocket';
import { WindowsNamedPipeTransport } from './windowsNamedPipe';

export type {
  RichPresenceEndpoint,
  RichPresenceTransport,
  RichPresenceTransportKind,
  RichPresenceTransportServer,
} from './types';
export { candidateSocketDirs, UnixSocketTransport } from './unixSocket';
export { discordNamedPipePath, WindowsNamedPipeTransport } from './windowsNamedPipe';

export function createRichPresenceTransport(
  platform: NodeJS.Platform = process.platform,
): RichPresenceTransport {
  return platform === 'win32'
    ? new WindowsNamedPipeTransport()
    : new UnixSocketTransport();
}
