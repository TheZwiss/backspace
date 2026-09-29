import type { ServerEvent } from '@backspace/shared';
import { callEvents } from './webSocketCallEvents';
import { chatEvents } from './webSocketChatEvents';
import { federationEvents } from './webSocketFederationEvents';
import { memberEvents } from './webSocketMemberEvents';
import { miscEvents } from './webSocketMiscEvents';
import { handleReady } from './webSocketReady';
import { socialEvents } from './webSocketSocialEvents';
import { spaceEvents } from './webSocketSpaceEvents';
import { voiceEvents } from './webSocketVoiceEvents';

export type WebSocketEventHandlers = {
  [Kind in ServerEvent['type']]?: (origin: string, event: Extract<ServerEvent, { type: Kind }>) => void;
};

const handlers = {
  ready: handleReady,
  ...chatEvents,
  ...memberEvents,
  ...voiceEvents,
  ...socialEvents,
  ...callEvents,
  ...federationEvents,
  ...spaceEvents,
  ...miscEvents,
};

export function handleEvent(origin: string, event: ServerEvent): void {
  // The discriminator selects the matching payload type from the same event.
  const handler = handlers[event.type as keyof typeof handlers];
  handler?.(origin, event as never);
}
