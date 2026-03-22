import type { RefObject } from 'react';
import type { MascotState } from '../components/ui/Mascot';

/**
 * Drives Mascot SVG animations (idle bob, sleeping breathe, etc.).
 * Stub — real implementation comes in Task 2.
 */
export function useMascotAnimation(
  _svgRef: RefObject<SVGSVGElement | null>,
  _containerRef: RefObject<HTMLDivElement | null>,
  _state: MascotState,
): void {
  // Task 2 implements animation logic
}
