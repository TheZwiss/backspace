// Every colour the hello scene paints with. Each value is derived from an
// Aether Drift token in packages/web/src/styles/globals.css; the scene never
// writes a colour literal anywhere else. Nothing here is pure black or white.
export const SCENE_PALETTE = {
  // --bg-chat, the warm dark the whole app sits on.
  void: '#13131a',
  // --accent-lavender, painted at low opacity through the noise filter.
  nebulaA: '#c4b5fd',
  // --accent-peach, same treatment on the opposite corner.
  nebulaB: '#fca5a5',
  // --text-primary warmed two steps, so stars are never #ffffff.
  star: '#f3ede4',
  // --accent-mint, the lit side of the hull.
  hull: '#86efac',
  // --accent-lavender pulled toward --accent-primary: the shaded rim, fins and porthole ring.
  hullShade: '#b3a7f3',
  // --accent-amber toned down, the cabin light in idle.
  window: '#f2c76a',
  // --accent-amber lifted, the cabin when it brightens and the pilot's eyes.
  windowLit: '#fde8ad',
  // --bg-channel warmed, the pilot silhouette.
  pilot: '#1c1826',
  // Between window and windowLit, so the beam reads as the window's own light.
  beam: '#fdf0c8',
} as const;

export type ScenePalette = typeof SCENE_PALETTE;
