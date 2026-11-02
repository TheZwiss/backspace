import { useEffect, useState, type RefObject } from 'react';

type Video = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type Container = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };

export function useStreamFullscreen(videoRef: RefObject<HTMLVideoElement | null>) {
  const [active, setActive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const doc = document as FullscreenDocument;
    const change = () => setActive(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    const end = () => { setActive(false); setExpanded(false); };
    const video = videoRef.current;
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('webkitfullscreenchange', change);
    video?.addEventListener('webkitendfullscreen', end);
    return () => {
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('webkitfullscreenchange', change);
      video?.removeEventListener('webkitendfullscreen', end);
    };
  });
  const toggle = () => {
    const doc = document as FullscreenDocument;
    if (active || expanded) {
      setActive(false); setExpanded(false);
      if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
      else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.();
      return;
    }
    const video = videoRef.current as Video | null;
    const container = video?.parentElement as Container | null;
    if (!video || !container) return;
    const fallback = () => { setExpanded(true); setActive(true); };
    try {
      // Invoke during the tap, before awaiting anything, to retain user activation.
      if (container.requestFullscreen) void container.requestFullscreen().then(() => setActive(true), fallback);
      else if (container.webkitRequestFullscreen) void Promise.resolve(container.webkitRequestFullscreen()).then(() => setActive(true), fallback);
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); setActive(true); }
      else fallback();
    } catch { fallback(); }
  };
  useEffect(() => {
    if (!expanded) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setExpanded(false); setActive(false); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [expanded]);
  return { active, expanded, toggle };
}
