export interface MediaTrackInfo {
  title: string;
  artist: string;
  album?: string;
  artUrl?: string;
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  player: string;
  sourceUrl?: string;
  mediaType?: 'music' | 'video';
}

export interface MediaActivity {
  type: 'listening' | 'watching';
  name: string;
  details?: string;
  state?: string;
  timestamps?: {
    start?: number;
    end?: number;
  };
  playback?: {
    positionMs: number;
    durationMs?: number;
  };
  assets?: {
    largeImage?: string;
    largeText?: string;
    smallImage?: string;
    smallText?: string;
  };
  url?: string;
}
