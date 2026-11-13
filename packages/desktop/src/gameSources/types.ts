export interface GameSourceProcess {
  name: string;
  cmdline: string;
  exe: string | null;
  winExes?: string[];
  cwd?: string;
}

export interface MatchedGame {
  id: string;
  name: string;
  type: string;
}

export type SourceDetector = (info: GameSourceProcess) => MatchedGame | null;
