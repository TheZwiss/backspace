/**
 * The resizable desktop columns. Every column follows one rule: its default
 * width is also its minimum (the layout is designed at that width, so it can
 * only grow), and `maxWidth` caps how far it grows. Widths are layout
 * (unzoomed) pixels. Adding a column here gives it a persisted width in
 * uiStore; the column renders a `<PanelResizer panel="…" />` on its `edge`.
 */
export interface ResizablePanelConfig {
  defaultWidth: number;
  maxWidth: number;
  /** The column edge the divider sits on, i.e. the edge that moves. */
  edge: 'left' | 'right';
  /** `common` namespace key for the divider's accessible name. */
  labelKey: 'chrome.resizeChannelSidebar' | 'chrome.resizeMemberList';
}

export const RESIZABLE_PANELS = {
  /** The left column: the 72px space rail plus the channel sidebar. */
  channelSidebar: { defaultWidth: 312, maxWidth: 480, edge: 'right', labelKey: 'chrome.resizeChannelSidebar' },
  /** The right column: member list, group-DM roster or activity panel. */
  memberList: { defaultWidth: 240, maxWidth: 400, edge: 'left', labelKey: 'chrome.resizeMemberList' },
} as const satisfies Record<string, ResizablePanelConfig>;

export type ResizablePanelId = keyof typeof RESIZABLE_PANELS;

export type PanelWidths = Record<ResizablePanelId, number>;

export const RESIZABLE_PANEL_IDS = Object.keys(RESIZABLE_PANELS) as ResizablePanelId[];

export function clampPanelWidth(panel: ResizablePanelId, width: number): number {
  const { defaultWidth, maxWidth } = RESIZABLE_PANELS[panel];
  if (!Number.isFinite(width)) return defaultWidth;
  return Math.round(Math.min(maxWidth, Math.max(defaultWidth, width)));
}

/** Every panel at its default, or `stored` clamped panel by panel. Stored
 *  values may be stale (older bounds), partial or hand-edited. */
export function resolvePanelWidths(stored?: Partial<Record<string, unknown>>): PanelWidths {
  const widths = {} as PanelWidths;
  for (const panel of RESIZABLE_PANEL_IDS) {
    const value = stored?.[panel];
    widths[panel] = typeof value === 'number'
      ? clampPanelWidth(panel, value)
      : RESIZABLE_PANELS[panel].defaultWidth;
  }
  return widths;
}
