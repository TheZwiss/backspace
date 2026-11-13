/**
 * One-shot flag distinguishing a deliberate camera-off from an unexpected
 * track end (hardware unplug, OS permission revoke). Set immediately before
 * `setCameraEnabled(false)` on every deliberate path; consumed and cleared by
 * the camera-track `ended` handler in useLiveKit. Module-level by design:
 * never persisted, never on the store, single producer + single consumer.
 */
let intentionalCameraOff = false;

export function markIntentionalCameraOff(): void {
  intentionalCameraOff = true;
}

export function consumeIntentionalCameraOff(): boolean {
  const value = intentionalCameraOff;
  intentionalCameraOff = false;
  return value;
}
