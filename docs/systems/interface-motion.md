# Interface motion

## Review and plan

The existing shared modal shell already fades its backdrop and slides its content.
The mobile screen stack already slides pushed screens. Channel/DM navigation and
root mobile tabs change abruptly; settings panels appear abruptly after lazy loading.
Context menus fade, while status menus appear immediately. Reduced motion previously
covered only selected decorative call effects and skeletons.

Use one short rhythm (120 ms menus, 150 ms navigation, 180 ms panels/dialogs), with
an ease-out curve. Move small floating surfaces only 3–6 px. Avoid layout, blur,
height animations, per-message staggering and new dependencies.

## Implementation

- Desktop route changes and mobile root tabs use `useNavigationMotion`, a short
  opacity transition. Rapid navigation cancels the preceding effect. Components,
  editors and media remain mounted; the effect introduces no transform around
  fullscreen/fixed overlays. It runs on navigation, not on incoming messages.
- The settings lazy boundary fades the loaded content into view for both desktop
  and mobile. Existing tab keys and panel lifetimes are preserved.
- Shared dialog entrances use the common timing curve and smaller displacement.
  Context menus and status menus use a consistent short entrance.
- CSS respects reduced motion across animations and transitions. Navigation skips
  the Web Animation entirely and cancels it if the preference changes. Mobile
  push/pop skips its delayed exit when reduced motion is already enabled.

Existing mobile push/pop and call chrome timings remain at their established
durations. Shared modals, context menus (including mobile sheets), the sidebar
status menu and the account status picker now fade out for 120 ms. React dismisses
the real surface immediately; a transient inert, aria-hidden visual copy remains
in its owner document/fullscreen container. It has no handlers, duplicate IDs or
media sources. It cannot intercept clicks or receive focus, and is removed on
completion, preference change or a 180 ms fallback. StrictMode effect replay does
not create a copy. Navigation itself remains an incoming fade: delaying route
changes or retaining old calls/editors to animate them out would add latency.

## Validation

Type checking and focused regression tests cover navigation animation cancellation,
preserving child state, reduced motion and settings lazy loading. Visual acceptance
should include rapid channel/DM switching, settings tabs, nested menus, fullscreen
calls and mobile navigation, with reduced motion both enabled and disabled.
