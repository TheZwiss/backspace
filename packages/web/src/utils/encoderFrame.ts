/** Some hardware WebRTC paths scale the coded surface instead of its visible
 * rectangle. Materialize padded frames at display size before handing them off.
 * No pixel readback is performed; ordinary unpadded frames pass through. */
export function createEncoderFrameNormalizer(): (frame: VideoFrame) => VideoFrame {
  let canvas: OffscreenCanvas | undefined;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  return (frame) => {
    const visible = frame.visibleRect;
    if (!visible || (visible.x === 0 && visible.y === 0
      && visible.width === frame.codedWidth && visible.height === frame.codedHeight)) return frame;
    if (!canvas) {
      canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
      context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Encoder frame surface unavailable');
    }
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
    // drawImage honors visibleRect; all visible rows survive this conversion.
    context!.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
    return new VideoFrame(canvas, {
      timestamp: frame.timestamp,
      ...(frame.duration !== null ? { duration: frame.duration } : {}),
    });
  };
}
