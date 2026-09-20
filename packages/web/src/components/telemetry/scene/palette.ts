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

  // ── Rooms and stations (added by the UI soul pass) ──
  // --bg-channel warmed one step: the floor and bulkheads of any interior.
  deck: '#1d1a26',
  // --bg-elevated: the lit face of interior structure.
  bulkhead: '#252530',
  // --accent-sky: standby lights on instruments, the colour of "ready". Painted
  // at low opacity; the hex is the light itself.
  console: '#7dd3fc',
  // Same value as hullShade, named for the role: anything inside a room that
  // has turned away from the key.
  seat: '#b3a7f3',
  // Same value as hull, named for the role: an outgoing or live signal, a
  // plotted course, a friend who is here.
  signal: '#86efac',
  // --accent-peach pulled toward --accent-coral: an incoming call, someone
  // wanting attention.
  hail: '#fc9c7a',
  // --accent-rose at the derelict's saturation: a beacon that has gone dark,
  // an invalid invite.
  warn: '#e39aa4',

  // ── The derelict (lifted from SilenceButton, which now reads the same
  //    values as --derelict-* tokens in globals.css) ──
  // The starlit face, upper left.
  derelictLit: '#232531',
  // The hull's own colour.
  derelictBody: '#181922',
  // The unlit end. Above --bg-base on purpose: matched to the void, a
  // silhouette has no edge.
  derelictFar: '#111219',
  // Frost and starlight: --accent-lavender toward sky. Also "dust".
  dust: '#c7d2fe',
  // The carrier's slate.
  derelictSignal: '#8c98ba',
} as const;

export type ScenePalette = typeof SCENE_PALETTE;
