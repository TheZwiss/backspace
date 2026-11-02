import type { SVGProps } from 'react';
const paths = { bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4', play: 'm9 5 10 7-10 7V5Z', pause: 'M8 5v14M16 5v14', close: 'm6 6 12 12M6 18 18 6' };
export function ControlIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
