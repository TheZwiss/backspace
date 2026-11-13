import { useRef, type HTMLAttributes } from 'react';
import { useExitMotion } from '../../hooks/useExitMotion';

export function MotionMenu(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useExitMotion(ref);
  return <div {...props} ref={ref} />;
}
