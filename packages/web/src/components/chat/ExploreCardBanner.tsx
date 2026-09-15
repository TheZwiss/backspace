import type { ReactNode } from 'react';

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
 * in for one, with the frosted bottom fade the overlapping icon sits on. The
 * badges are the caller's. Structure only; the material version was rejected
 * (scene bible section 12).
 */
export function ExploreCardBanner({ bannerUrl, gradient, children }: ExploreCardBannerProps) {
  return (
    <div className="h-32 relative overflow-hidden">
      {bannerUrl ? (
        <img src={bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0" style={{ background: gradient }} />
      )}
      <div
        className="absolute bottom-0 inset-x-0 h-16"
        style={{ background: 'linear-gradient(to top, rgba(20,20,26,0.9), transparent)' }}
      />
      {children}
    </div>
  );
}
