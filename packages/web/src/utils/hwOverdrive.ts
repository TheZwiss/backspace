// packages/web/src/utils/hwOverdrive.ts
//
// Self-contained SDP profile override for hardware H.264 encoding.
// Zero imports from our codebase — operates at the WebRTC API layer.

let _active = false;
let _originalCreateOffer: typeof RTCPeerConnection.prototype.createOffer | null = null;

function rewriteSdp(sdp: string): string {
  return sdp.replace(/profile-level-id=(42e01f|42c01f)/gi, 'profile-level-id=4d0032');
}

/**
 * Activate the SDP profile override.
 * Patches RTCPeerConnection.prototype.createOffer to rewrite
 * H.264 Constrained Baseline (42e01f/42c01f) → Main Profile (4d0032).
 * No-op if already active.
 */
export function activate(): void {
  if (_active) return;

  _originalCreateOffer = RTCPeerConnection.prototype.createOffer;
  _active = true;

  // RTCPeerConnection.prototype.createOffer has two overloads in the WebRTC typings.
  // We cast through unknown to satisfy TypeScript while keeping the runtime shape correct.
  const patched: typeof RTCPeerConnection.prototype.createOffer = async function (
    this: RTCPeerConnection,
    options?: RTCOfferOptions,
  ): Promise<RTCSessionDescriptionInit> {
    const offer = await (_originalCreateOffer as (options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>).call(this, options);
    if (_active && offer.sdp) {
      return { type: offer.type, sdp: rewriteSdp(offer.sdp) };
    }
    return offer;
  } as unknown as typeof RTCPeerConnection.prototype.createOffer;

  RTCPeerConnection.prototype.createOffer = patched;
}

/**
 * Deactivate the SDP profile override.
 * Restores the original createOffer prototype. No-op if not active.
 */
export function deactivate(): void {
  if (!_active) return;
  if (_originalCreateOffer) {
    RTCPeerConnection.prototype.createOffer = _originalCreateOffer;
    _originalCreateOffer = null;
  }
  _active = false;
}

/** Check if the SDP override is currently active. */
export function isActive(): boolean {
  return _active;
}
