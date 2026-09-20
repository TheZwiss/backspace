import type { ReactNode } from 'react';
import { Mascot } from '../ui/Mascot';
import { OpenSpace } from '../ui/CrewEmptyState';
import './ExploreEmpty.css';

interface ExploreEmptyProps {
  /** True when a search produced nothing, false when the instance has nothing discoverable at all. */
  searched: boolean;
  /** The line of copy, already translated by the caller. */
  children: ReactNode;
}

/**
 * The patches of sky the two explore states sit under. They continue the
 * crew states' numbering so no empty state in the app repeats another's sky.
 */
const SKY = { bare: 6, searched: 7 } as const;

/**
 * The explore page with nothing to show (scene bible row 8, second pass):
 * Nori alone in open space, the same treatment as every crew state. The copy
 * arrives translated from the page; this owns the picture. A fixed-height
 * block, since it sits above the joined-spaces list on that page.
 */
export function ExploreEmpty({ searched, children }: ExploreEmptyProps) {
  return (
    <div className={`explore-empty ${searched ? 'explore-empty--searched' : 'explore-empty--bare'} relative flex flex-col items-center justify-center h-64 overflow-hidden`}>
      <OpenSpace sky={searched ? SKY.searched : SKY.bare} density="field" className="explore-empty__space" />
      <div className="explore-empty__stage w-32 h-32 mb-4">
        <Mascot state="lonely" className="w-full h-full" />
      </div>
      <p className="explore-empty__copy text-sm text-center">{children}</p>
    </div>
  );
}
