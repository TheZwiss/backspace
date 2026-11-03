export function shouldRenderLocalScreenPreview(track: MediaStreamTrack | null, active: boolean): boolean {
  return active && track?.readyState === 'live';
}
