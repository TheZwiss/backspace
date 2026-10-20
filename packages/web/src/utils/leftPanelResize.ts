/**
 * Width bounds for the app-shell left column, in CSS layout pixels.
 *
 * One width serves the whole left column — the 72px glass space rail plus the
 * list beside it, whether that list is the space channel list or the home DM
 * list (ChannelSidebar renders both) — because the column is one grid track
 * and a width the user chose in one view should not snap back in the other.
 *
 * The pre-resize layout was a fixed 312px column (72px rail + 240px list), so
 * 312 stays the default. The bounds keep the list itself inside the same
 * 180-420px range as the right column: 252 = 72 + 180 keeps channel names and
 * unread badges readable, 492 = 72 + 420 leaves the chat column room to live
 * on ordinary desktop widths.
 */
export const LEFT_PANEL_DEFAULT_WIDTH = 312;
export const LEFT_PANEL_MIN_WIDTH = 252;
export const LEFT_PANEL_MAX_WIDTH = 492;

/** Width change per arrow-key press on the resize handle. Shift multiplies by 4. */
export const LEFT_PANEL_KEYBOARD_STEP = 16;

/**
 * Clamp a proposed left-column width into [MIN, MAX]. Fractional input is
 * rounded (drag deltas land on subpixel coordinates; the column renders at
 * whole pixels) and non-finite input falls back to the default so a corrupted
 * persisted value can never wedge the layout.
 */
export function clampLeftPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return LEFT_PANEL_DEFAULT_WIDTH;
  return Math.min(LEFT_PANEL_MAX_WIDTH, Math.max(LEFT_PANEL_MIN_WIDTH, Math.round(px)));
}
