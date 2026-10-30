/** A game icon ready for hand-off to the renderer: bytes plus a sniffed MIME. */
export interface GameIcon {
  bytes: Buffer;
  mime: string;
}

/** What the detector knows about the game it wants an icon for. */
export interface GameIconTarget {
  /** MatchedGame.id: `steam-<appid>`, `flatpak-<appid>`, `gog-<id>`, or a dictionary key. */
  id: string;
  /** The display name the activity carries; keys the cache the renderer asks by. */
  name: string;
  /** Full executable path of the running game, when the process scan exposed one. */
  exe: string | null;
  /** The process command line (may name the AppImage the binary was mounted from). */
  cmdline: string;
  /** Windows program names of a Wine process (`ZenlessZoneZero.exe`). */
  winExes?: string[];
  /** Working directory of that process: where the program's own `.exe` lies. */
  cwd?: string | null;
}
