import type net from 'net';

export type RichPresenceTransportKind = 'unix-socket' | 'named-pipe';

export interface RichPresenceEndpoint {
  id: string;
  address: string;
  kind: RichPresenceTransportKind;
}

export interface RichPresenceTransportServer {
  endpoint: RichPresenceEndpoint;
  close(): void;
}

export interface RichPresenceTransport {
  readonly kind: RichPresenceTransportKind;
  listAvailableEndpoints(): Promise<RichPresenceEndpoint[]>;
  listen(
    endpoint: RichPresenceEndpoint,
    onConnection: (socket: net.Socket) => void,
  ): Promise<RichPresenceTransportServer | null>;
}
