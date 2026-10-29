/**
 * Tell the desktop which programs the player's own games are tied to, so its
 * detector shows each game while its program runs. A browser, or a desktop
 * build that predates the binding, has no such channel and ignores this.
 */
export function syncManualBindings(bindings: Array<{ name: string; process: string }>): void {
  const bridge = window.backspace;
  if (!bridge) return;
  if (bridge.setManualGameBindings) {
    bridge.setManualGameBindings(bindings).catch(() => {});
  } else if (bridge.setManualGameBinding) {
    // A desktop from before the list can follow one program
    bridge.setManualGameBinding(bindings[0] ?? null).catch(() => {});
  }
}
