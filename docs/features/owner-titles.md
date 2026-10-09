# Owner display titles

The owner group heading supports a cosmetic, space-scoped title. Only the actual
owner (including the host-local identity on remote spaces) may edit it; MANAGE_SPACE
does not grant this right. PATCH /api/spaces/:id accepts ownerTitle as a trimmed,
non-empty single line of at most 32 characters, or null to reset. Invalid mixed
patches are rejected before any write. Ownership transfer clears the old title.

The host persists the value, includes it in space responses and ready payloads, and
broadcasts changes through the existing space_updated event. The editor waits for
the server response and exposes failures. Migration 0027 adds only spaces.owner_title.

This change does not include member menus, nicknames, pokes, mentions, notification
settings or store/router/WebSocket refactoring from the previous feature branch.
