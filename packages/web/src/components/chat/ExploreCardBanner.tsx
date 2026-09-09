import type { ReactNode } from 'react';
import './ExploreCardBanner.css';

interface ExploreCardBannerProps {
  /** The space's uploaded banner, already resolved to a URL, or null. */
  bannerUrl: string | null;
  /** The fallback when there is no banner: the gradient derived from the icon or the avatar colour. */
  gradient: string;
  /** Badges the card overlays on the banner. */
  children?: ReactNode;
}

/**
 * The top of an explore card: the space's banner, or the gradient that stands
 * in for one. Owned by the UI soul pass (scene bible row 8), so a card without
 * a banner stops reading as a placeholder. The badges are the caller's.
 *
 * Material only, no subject. The gradient variant is given a surface to be:
 * grain, a vignette that takes light away at the corners, the rim turning
 * with the key along the top edge, and one specular at the top left. A photo
 * keeps its own light and gets only the rim and a touch of the specular. The
 * frosted bottom fade is untouched: the icon that overlaps the banner sits on
 * it. Every layer ignores the pointer, so the badges stay clickable.
 */
export function ExploreCardBanner({ bannerUrl, gradient, children }: ExploreCardBannerProps) {
  return (
    <div className={`explore-banner ${bannerUrl ? 'explore-banner--image' : 'explore-banner--gradient'} h-32 relative overflow-hidden`}>
      {bannerUrl ? (
        <img src={bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <>
          <div className="explore-banner__fill absolute inset-0" style={{ background: gradient }} />
          <div className="explore-banner__grain" aria-hidden="true" />
          <div className="explore-banner__vignette" aria-hidden="true" />
        </>
      )}
      {/* Frosted bottom fade, so the icon that overlaps the banner sits on glass. */}
      <div
        className="explore-banner__fade absolute bottom-0 inset-x-0 h-16"
        style={{ background: 'linear-gradient(to top, rgba(20,20,26,0.9), transparent)' }}
      />
      <div className="explore-banner__specular" aria-hidden="true" />
      <div className="explore-banner__sheen" aria-hidden="true" />
      <div className="explore-banner__rim-fade" aria-hidden="true">
        <div className="explore-banner__rim" />
      </div>
      {children}
    </div>
  );
}
