import { useEffect, useRef, useState } from 'react';

interface UseFileDropZoneOptions {
  /** When false no listener is attached and the browser keeps its default drop behaviour. */
  enabled: boolean;
  /**
   * Called synchronously from the `drop` event. The DataTransfer is only
   * readable for the duration of that event, so the callback must read
   * `items` / `files` before its first await.
   */
  onDrop: (dataTransfer: DataTransfer) => void;
}

/** True only for drags that carry files from outside the page (text, links and in-app drags do not). */
function carriesFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes('Files');
}

/**
 * Turns `region` into a file drop target and reports whether a file drag is
 * currently over it. The region covers its descendants, so one listener set
 * serves the whole subtree and nested children do not make the state flicker
 * (enter/leave are counted). The state is held for as long as the drag stays
 * over the region, however still the pointer is: `dragover` is not repeated
 * on every platform, so nothing here may expire on a timer.
 */
export function useFileDropZone(
  region: HTMLElement | null,
  { enabled, onDrop }: UseFileDropZoneOptions,
): boolean {
  const [dragging, setDragging] = useState(false);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!region || !enabled) return undefined;

    let depth = 0;

    const reset = (): void => {
      depth = 0;
      setDragging(false);
    };

    const onDragEnter = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return;
      // Without preventDefault the browser refuses the drop and opens the file instead.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onDropEvent = (e: DragEvent): void => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      reset();
      if (e.dataTransfer) onDropRef.current(e.dataTransfer);
    };

    region.addEventListener('dragenter', onDragEnter);
    region.addEventListener('dragover', onDragOver);
    region.addEventListener('dragleave', onDragLeave);
    region.addEventListener('drop', onDropEvent);
    // A drag released outside the region or cancelled with Escape ends on the window.
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);

    return () => {
      region.removeEventListener('dragenter', onDragEnter);
      region.removeEventListener('dragover', onDragOver);
      region.removeEventListener('dragleave', onDragLeave);
      region.removeEventListener('drop', onDropEvent);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
      reset();
    };
  }, [region, enabled]);

  return dragging;
}
