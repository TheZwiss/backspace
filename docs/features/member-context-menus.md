# Member context menus and space nicknames

This change is independent of mention composition, notification preferences, unread counts, pokes, owner titles and personal stickers.

- Right-click a member to open profile, DM/friend actions, permitted role actions, or the existing kick/ban flows. Left-click still opens the profile.
- Space nicknames are separate from account names. Members can change their own nickname; MANAGE_SPACE permits changing another non-owner member's nickname. Use null to reset; non-empty values are trimmed, single-line and at most 32 characters.
- Role updates retain the upstream hierarchy and held-permission-bit checks. Mixed role/nickname PATCH bodies validate completely before the transaction writes anything.
- The existing member PATCH handler is extracted solely to extend it with nicknames. No schema migration or unrelated route/WebSocket/store split is included.
- The member_updated event updates only the matching space and origin. It preserves cached profile/presence data; role changes also retain upstream access and voice permission refreshes.
- DM and friendship actions use the upstream origin-aware identity helpers. Role checkbox menus expose pending state and keyboard interaction; failed operations remain visible.

Validation: server and web test suites, TypeScript no-emit checks, ESLint, i18n parity, and diff whitespace checks. No production build or manual browser session was run.
