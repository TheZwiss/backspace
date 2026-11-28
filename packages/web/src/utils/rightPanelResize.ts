/**
 * Width bounds for the app-shell right column, in CSS layout pixels.
 *
 * One width serves every panel that occupies the right column — the space
 * member list (MemberSidebar), the group-DM roster (DmRosterPanel), and the
 * friends activity list (ActivityPanel) — because they visually swap inside
 * the same column and a width the user chose for one should not snap back for
 * another.
 *
 * The pre-resize layout was a fixed `w-60` (240px) column on all three panels,
 * so 240 stays the default. 180 keeps long display names readable with the
 * avatar + activity card intact; 420 matches a deliberately-broad roster
 * without starving the chat column on smaller desktop widths.
 */
export const RIGHT_PANEL_DEFAULT_WIDTH = 240;
export const RIGHT_PANEL_MIN_WIDTH = 180;
export const RIGHT_PANEL_MAX_WIDTH = 420;

/** Width change per arrow-key press on the resize handle. Shift multiplies by 4. */
export const RIGHT_PANEL_KEYBOARD_STEP = 16;

/**
 * Clamp a proposed right-column width into [MIN, MAX]. Fractional input is
 * rounded (drag deltas land on subpixel coordinates; the panel renders at
 * whole pixels) and non-finite input falls back to the default so a corrupted
 * persisted value can never wedge the layout.
 */
export function clampRightPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(px)));
}
