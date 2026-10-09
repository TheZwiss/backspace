# Composer mention display

The composer stores mention tokens as wire IDs (`<@userId>` and `<@&roleId>`), but paints their known names in a mirror over a native textarea. Sending, saved drafts and reply behavior continue to use the original wire text.

- User labels use the current channel's people and the canonical user view; a DM never borrows the roster of another space. A known self mention can be displayed even though DM autocomplete excludes self.
- Editing or selecting through a displayed mention replaces the complete token, so partial edits cannot leave a corrupt user ID. Pasted display names are ordinary text, not implicit mentions.
- Unknown IDs and tokens inside code remain literal. The textarea retains native composition, selection and paste handling; Enter during IME composition does not send or select a suggestion.
- Mention suggestions are anchored at the typed @ rather than the composer edge; the mirror follows native scrolling.

This feature adds no notification settings, mass-mention permissions, unread counts, member menus, or changes to send/draft lifecycle.
