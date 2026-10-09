# Permission-aware mass mentions

This change extends upstream notification preferences instead of replacing their
API, store, mute handling, or notification-level controls.

## Tokens and permission

- `@everyone` and `@here` address channel viewers. In this implementation,
  `@here` has the same audience as `@everyone`; it is not an online-only filter.
- `<@&roleId>` addresses members holding that role in the channel's space.
- All three require `MENTION_EVERYONE` (bit 15), including when editing a
  message. HTTP and WebSocket paths enforce the same channel-aware permission.
  The default everyone role does not receive this permission.
- Direct user mentions are unchanged. Tokens in inline or fenced code do not
  count as mentions. Mass mentions render as labels rather than profile links.

## Recipient preferences

The existing space notification-settings PATCH accepts boolean
`suppressEveryone` and `suppressRoles`. Both default to false; omitting
a field preserves it. Channel PATCH rejects either flag: channel overrides
cannot bypass space-wide suppression. A suppression-only setting is retained
until all choices are cleared. Updates use the existing cross-session event.

Suppression only removes the respective group-triggered alerts from the
`mentions` policy. Direct mentions still alert. Muted or `nothing` channels
still never alert, while `all` and the existing every-message sound option
continue to deliver explicitly requested alerts. DM rules are unchanged.

Role matching uses the recipient's instance-local membership from ready and
space-detail responses, including spaces not currently open in the UI.

## Storage and scope

Migration `0027_mass_mention_preferences` adds only two boolean columns to
upstream's `notification_settings` table, preserving existing level and mute
choices. No replacement notification table, navigation changes, unrelated
features, or historical refactors are included.
