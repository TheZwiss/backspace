/**
 * Which item of the DM sidebar's home block is selected.
 *
 * One function for all three items, because the selection is one fact: two
 * inline conditions per item is how a third page ends up with two items
 * selected at once. The space rail's `@me` item reads it too, to stay active
 * on `/backspace`.
 *
 * `/explore` and `/backspace` are pages in the main area and win over a
 * lingering channel id. Anywhere else the Friends view is what shows when no
 * channel is open, and with a channel open none of the three is selected.
 */

export type HomeNavItem = 'friends' | 'explore' | 'backspace';

export function activeHomeNavItem(pathname: string, currentChannelId: string | null): HomeNavItem | null {
  if (pathname === '/explore') return 'explore';
  if (pathname === '/backspace') return 'backspace';
  if (currentChannelId === null) return 'friends';
  return null;
}
