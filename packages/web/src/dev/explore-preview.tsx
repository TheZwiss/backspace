// Dev-only workbench for the explore page (scene bible row 8): the empty state
// and the card banner. Nothing in the app imports this file;
// `dev-explore.html` is its only entry. Cards are replicas of ExplorePage's
// SpaceCard around the real ExploreCardBanner; one has an uploaded banner (a
// generated image), the others fall back to a gradient.
import { ExploreCardBanner } from '../components/chat/ExploreCardBanner';
import { ExploreEmpty } from '../components/chat/ExploreEmpty';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

/** A stand-in for an uploaded banner: a soft two-colour SVG, so no external asset is needed. */
const BANNER_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='480' height='160'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#7dd3fc'/><stop offset='1' stop-color='#c4b5fd'/></linearGradient></defs><rect width='480' height='160' fill='url(#g)'/><circle cx='360' cy='60' r='48' fill='#fde8ad' opacity='0.8'/></svg>",
  );

function Card({ name, description, members, joined, bannerUrl, gradient }: { name: string; description: string | null; members: number; joined: boolean; bannerUrl: string | null; gradient: string }) {
  return (
    <div className={`bg-surface-channel rounded-lg border overflow-hidden flex flex-col ${joined ? 'border-accent-mint/20' : 'border-border-soft'}`} style={{ width: 300 }}>
      <ExploreCardBanner bannerUrl={bannerUrl} gradient={gradient}>
        {joined && (
          <div className="absolute top-2 left-2 z-[2]">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-mint/25 text-accent-mint backdrop-blur-sm">Joined</span>
          </div>
        )}
        <div className="absolute top-2 right-2 z-[2]">
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm bg-accent-mint/20 text-accent-mint">Public</span>
        </div>
      </ExploreCardBanner>
      <div className="relative px-4 -mt-8 z-10">
        <div className="w-14 h-14 rounded-xl ring-[3px] ring-surface-channel shadow-lg flex items-center justify-center text-xl font-bold text-white/90" style={{ background: gradient }}>
          {name.charAt(0)}
        </div>
      </div>
      <div className="px-4 pt-2 pb-4 flex flex-col flex-1">
        <h3 className="text-[15px] font-bold text-txt-primary truncate mb-1">{name}</h3>
        <p className={`text-[13px] mb-3 flex-1 ${description ? 'text-txt-secondary' : 'text-txt-tertiary italic'}`}>{description ?? 'No description'}</p>
        <p className="text-[12px] text-txt-tertiary mb-3">{members} members</p>
        <button type="button" className={joined ? 'w-full py-2 rounded bg-accent-mint/10 text-accent-mint text-sm font-medium' : 'cta-primary w-full py-2 text-sm rounded'}>
          {joined ? 'View Space' : 'Join Space'}
        </button>
      </div>
    </div>
  );
}

function Workbench() {
  return (
    <WorkbenchPage
      title="Explore — design workbench"
      description="The explore page with nothing plotted, and the card banner with and without an uploaded image. The cards are replicas of the real SpaceCard around the real ExploreCardBanner."
    >
      <Section title="Empty: nothing discoverable (1000 wide), and a search with no matches (560 wide)">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ width: 1000, background: 'rgb(var(--bg-chat))', borderRadius: 8, boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
            <ExploreEmpty searched={false}>No discoverable spaces yet.</ExploreEmpty>
          </div>
          <div style={{ width: 560, background: 'rgb(var(--bg-chat))', borderRadius: 8, boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
            <ExploreEmpty searched>No spaces match your search.</ExploreEmpty>
          </div>
        </div>
      </Section>
      <Section title="Cards: one uploaded banner, three gradient fallbacks">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: 24, background: 'rgb(var(--bg-chat))', borderRadius: 8 }}>
          <Card name="Koboldtruppe" description="A place for the crew" members={17} joined bannerUrl={BANNER_IMAGE} gradient="linear-gradient(135deg, #7dd3fc, #c4b5fd)" />
          <Card name="Backrooms" description={null} members={4} joined={false} bannerUrl={null} gradient="linear-gradient(135deg, #5b8def, #3b5bdb)" />
          <Card name="Aquis Plaza" description="Weekly voice hangouts" members={9} joined={false} bannerUrl={null} gradient="linear-gradient(135deg, #34d399, #059669)" />
          <Card name="Metaverse" description={null} members={2} joined bannerUrl={null} gradient="linear-gradient(135deg, #c4b5fd, #8b5cf6)" />
        </div>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
