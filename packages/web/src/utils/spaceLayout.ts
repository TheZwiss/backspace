import type { SpaceFolder, SpaceLayoutItem } from '@backspace/shared';
import type { TaggedSpace } from '../stores/spaceStore';

/** One entry of the space rail as it is drawn: a lone space or a folder of them. */
export type ResolvedSpaceLayoutItem =
  | { type: 'space'; space: TaggedSpace }
  | { type: 'folder'; folder: SpaceFolder; spaces: TaggedSpace[] };

/**
 * The space rail as the user sees it: the stored layout, reconciled against
 * the spaces and folders that actually exist.
 *
 * Layout entries whose space or folder is gone are dropped, a folder whose
 * spaces are all gone is dropped, and spaces the layout does not mention yet
 * (newly joined, or no layout stored at all) are appended in store order.
 * The desktop rail and the mobile Spaces screen both draw this, and anything
 * that has to name "the first space in your sidebar" reads it too, so all of
 * them agree on the order.
 */
export function resolveSpaceLayout(
  spaces: readonly TaggedSpace[],
  spaceLayout: readonly SpaceLayoutItem[] | null,
  folders: readonly SpaceFolder[],
): ResolvedSpaceLayoutItem[] {
  const spaceMap = new Map(spaces.map((s) => [s.id, s]));
  const folderMap = new Map(folders.map((f) => [f.id, f]));
  const result: ResolvedSpaceLayoutItem[] = [];
  const accounted = new Set<string>();

  for (const item of spaceLayout ?? []) {
    if (item.t === 's') {
      const space = spaceMap.get(item.id);
      if (space) {
        result.push({ type: 'space', space });
        accounted.add(space.id);
      }
    } else if (item.t === 'f') {
      const folder = folderMap.get(item.id);
      if (!folder) continue;
      const folderSpaces = folder.spaceIds
        .map((sid) => spaceMap.get(sid))
        .filter((s): s is TaggedSpace => !!s);
      if (folderSpaces.length > 0) {
        result.push({ type: 'folder', folder, spaces: folderSpaces });
        for (const s of folderSpaces) accounted.add(s.id);
      }
    }
  }

  for (const space of spaces) {
    if (!accounted.has(space.id)) {
      result.push({ type: 'space', space });
      accounted.add(space.id);
    }
  }

  return result;
}

/** The rail flattened top to bottom, a folder's spaces in the folder's order. */
export function spacesInLayoutOrder(layout: readonly ResolvedSpaceLayoutItem[]): TaggedSpace[] {
  return layout.flatMap((item) => (item.type === 'space' ? [item.space] : item.spaces));
}
