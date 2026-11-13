/**
 * Which source the screen-share setup screen stages on its own, and how a
 * re-enumeration lands in the grid it is already showing.
 *
 * Kept out of the component so it can be tested without pulling in the voice
 * graph, the way the desktop package keeps `screenSharePolicy.ts` out of
 * `main.ts`.
 */

/** The setup screen's two source tabs. */
export type ScreenSourceTab = 'screens' | 'windows';

/**
 * What to stage without being asked, when the app lists sources itself.
 *
 * The source shared last time wins: sharing the same monitor every day is the
 * common case, and re-staging it turns the screen into "open, glance at the
 * preview, Start". Failing that, a machine with exactly one screen has nothing
 * to choose between, so that screen is staged.
 *
 * Nothing is published by staging — the capture is local until Start — and the
 * user can still pick any other tile, which is why this is safe to do on open.
 *
 * Window ids (`window:12345:0`) are handles that only live as long as the
 * desktop session, so a remembered window stops matching after a restart and
 * the user simply picks again. Screen ids (`screen:0:0`) do survive.
 */
export function pickAutoStageSource(
  sources: ElectronScreenSource[],
  lastSourceId: string | null,
  activeTab: ScreenSourceTab,
): ElectronScreenSource | null {
  const remembered = lastSourceId ? sources.find((s) => s.id === lastSourceId) : undefined;
  if (remembered) return remembered;
  if (activeTab !== 'screens') return null;
  const screens = sources.filter((s) => s.isScreen);
  return screens.length === 1 ? screens[0]! : null;
}

/**
 * Fold a fresh enumeration into the grid that is already on screen.
 *
 * The setup screen re-lists while it is open, because windows come and go
 * (the whole point: a window opened after the screen opened must appear).
 * A plain `setSources(list)` would be wrong in two ways:
 *
 *  - Tiles would jump to the enumerator's order. On Windows that order is the
 *    z-order, which changes whenever the user switches windows — exactly what
 *    they do while choosing. Order is kept: sources that are still present
 *    keep their slot, and newcomers go first, where the eye is.
 *  - A cheap refresh (names and ids only, no thumbnails) would blank every
 *    tile's image on every poll. A source that arrives without a thumbnail
 *    keeps the one already decoded.
 */
export function mergeScreenSources(
  previous: readonly ElectronScreenSource[],
  incoming: readonly ElectronScreenSource[],
): ElectronScreenSource[] {
  const previousById = new Map(previous.map((source) => [source.id, source]));
  const incomingIds = new Set(incoming.map((source) => source.id));
  const merged: ElectronScreenSource[] = [];
  for (const source of incoming) {
    const known = previousById.get(source.id);
    if (!known) {
      merged.push(source);
      continue;
    }
    merged.push({
      ...source,
      thumbnailDataUrl: source.thumbnailDataUrl || known.thumbnailDataUrl,
      appIconDataUrl: source.appIconDataUrl ?? known.appIconDataUrl,
    });
  }
  // Keep the surviving tiles in the order the user is used to; newcomers stay
  // where the loop above put them (in front).
  const order = new Map(previous.map((source, index) => [source.id, index]));
  const newcomers = merged.filter((source) => !order.has(source.id));
  const survivors = merged
    .filter((source) => order.has(source.id))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return [...newcomers, ...survivors].filter((source) => incomingIds.has(source.id));
}

/** Whether two lists would render the same grid, so a poll can skip a state write. */
export function sameScreenSources(a: readonly ElectronScreenSource[], b: readonly ElectronScreenSource[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.id !== right.id || left.name !== right.name || left.thumbnailDataUrl !== right.thumbnailDataUrl) return false;
  }
  return true;
}
