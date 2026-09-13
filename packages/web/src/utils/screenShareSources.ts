/**
 * Which source the screen-share setup screen stages on its own.
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
