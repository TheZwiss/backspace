# Codec republish and call-window findings

Read-only findings from the live UI audit artifacts. No implementation or UI changes were made for this review.

## Rapid codec switching

`rapid-codec.json` records five codec selections across five rounds. Each round has one `localTrackUnpublished` and one `localTrackPublished` event. The receiver reports the same video node throughout (`same: true`); the audit observed zero DOM video removals, and the frozen canvas covered each observed track gap.

The first H264→VP9 transition is an outlier: the overlay starts at 330989.4 ms and ends at 334093.1 ms, lasting about 3103.7 ms. The receiver reports `hasTrack=false` from 331238.9 to 331293.0 ms (about 54.1 ms). The new track is therefore present for most of the remaining overlay interval before video advances (`time=0.399`, 7 frames at 334093.1 ms). The other transitions release the overlay shortly after the new track returns (roughly 11–20 ms in the recorded samples).

This is evidence of a long first-transition frame gap, not evidence that the DOM video was remounted. It does not establish a decoder-specific cause.

## Cold VP9 RTP capture

`cold-vp9-rtp.json` is a separate VP9 run after Bob's page reload. Its measured overlay window is about 350 ms (relative times 196–546 ms). Receiver RTP samples show a decoded VP9 keyframe (`keyFramesDecoded=1`), zero packet loss, and advancing received/decoded frame counts as the video resumes. At relative 503 ms the video is still at time 0 with zero presented frames; by 546 ms it has advanced to 0.04 s / 4 frames and is no longer frozen. Subsequent samples show frames and bytes progressing.

This shorter repeat demonstrates that a long multi-second pause is not a consistent outcome of a cold VP9 start. The one rapid-codec outlier should remain classified as unexplained. These captures alone do not identify whether the residual delay comes from source output, keyframe timing, transport/jitter buffering, decode, or presentation scheduling.

## Call-window context menu document mismatch

`call-window-context-menu-wrong-document.json` records a right-click in the child call window (`Backspace — Call`) with no menu in that child document, while the main `Backspace` document contains the stream context menu (stop/switch/quality). The observed result is that the menu opens in the wrong document for the interaction. This is consistent with the StreamTile context-menu target being resolved against the main document instead of the element's owning document; confirm/fix the target document when addressing this bug.

## Evidence limits

These are point-in-time runtime artifacts from the audited setup. The codec recordings establish timing and receiver RTP counters for those runs, not a universal codec behavior or a specific root cause. The context-menu JSON establishes the child/main document placement mismatch, but does not by itself isolate every event-routing detail that produced it.
