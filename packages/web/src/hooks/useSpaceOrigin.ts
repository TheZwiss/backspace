import { useSpaceStore } from '../stores/spaceStore';

/**
 * The instance that hosts space `spaceId` ('' = the page's own), which issued
 * its member rows. '' for a space the client does not list.
 */
export function useSpaceOrigin(spaceId: string | null | undefined): string {
  return useSpaceStore((s) => (spaceId ? s.spaces.find((sp) => sp.id === spaceId)?._instanceOrigin ?? '' : ''));
}
