# Recipient attention preferences

User Settings → Appearance → Chamadas de atenção. Stored locally on the device,
independent of the sender and of the instance. Existing saved movement mode is
preserved; new settings default to automatic app/desktop routing, sound enabled,
all monitors, automatic game detection, and notification-only while gaming.

| Setting | Behavior |
| --- | --- |
| Inside only | DOM animation and notice clipped to the Backspace window; never raises the app. Suppressed while minimized. |
| Outside only | Electron overlays only while Backspace is not focused. |
| Inside or outside | Inside while focused; desktop while background/minimized. |
| Disabled | No avatar loading, game scan, sound, notice, or animation. |
| Reduced motion | Gentle border pulse instead of movement or winks. |
| Notification only | Notice and optional sound, no screen animation or capture. |
| Sound off | No synthesized tones or movie audio. |

External effects can target all monitors, the primary monitor, the Backspace
monitor, or secondary monitors. Filtering occurs before windows are created;
removed displays are not silently replaced by a different monitor.

## Games

Automatic Windows detection reuses the game executable classifier and the
existing geometry helper. It enumerates window metadata without thumbnails only
on receipt, with at most four concurrent geometry queries and a bounded scan.
No additional continuous process or timer is installed. The existing activity
detector supplies a running-game fallback. A foreground exclusive D3D window is
also protected. Minimized windows have no active game monitor. Games spanning
multiple physical display rectangles protect every intersected monitor.

Users can activate game mode manually, disable it, consider only foreground
games, or protect any running game. During gaming they can choose normal
behavior, notices only, no calls, or animations only on monitors without games.
The game monitor can be automatic or overridden as primary, Backspace's monitor,
or secondary monitors. The override also supports games the classifier does not
recognize.

When no selected monitor is free, the game monitor is unknown, detection fails,
or only one monitor exists, the configured fallback is a notice, an in-app
notice, or suppression. Unknown automatic monitors are never classified as free.
An app-only scope never becomes a desktop overlay due to a game fallback.

Game classification cannot recognize every executable; manual mode and monitor
overrides cover those cases. Automatic monitor discovery uses the Windows
helper; other platforms use the running-game signal and the conservative
fallback or manual override. Exclusive fullscreen applications can prevent
desktop notifications from appearing. Browser-only sessions cannot render
desktop overlays or load the Electron-packaged original wink movies.

Native display changes abort active desktop overlays; future receipts use the
new display list. Preferences are evaluated when a call arrives. They do not
install a continuous game watcher for an already playing animation.
