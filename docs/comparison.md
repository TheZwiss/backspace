# Backspace compared to other chat platforms

This page is an honest look at how Backspace fits next to the tools people usually
weigh against it: Discord, Revolt, Spacebar, Matrix/Element, and Mumble. It
includes the places where those tools are the better choice. Feature sets change,
so verify current details on each project before you decide, and open an issue if
anything here is out of date.

Short version: Backspace is for people who want a Discord-style experience they
fully self-host, with serious voice and screen-share controls, and the option to
federate independently owned servers. If you need the largest ecosystem, a mature
open federation standard, or native mobile apps today, one of the others may suit
you better.

## Feature matrix

| | Backspace | Discord | Revolt | Spacebar | Matrix / Element | Mumble |
|---|---|---|---|---|---|---|
| Self-hostable | Yes | No | Yes | Yes | Yes | Yes |
| Open source | Yes (AGPL-3.0) | No | Yes | Yes | Yes | Yes |
| Discord-style UX | Yes | Yes | Yes | Yes (Discord client) | Different model | No |
| Text chat, roles, reactions | Yes | Yes | Yes | Yes | Yes | Limited |
| Voice channels | Yes | Yes | Yes | Partial | Yes | Yes (focus) |
| Video and screen share | Yes, up to 4K/120fps within admin bounds | Yes | Limited | Partial | Yes | No |
| Per-stream media controls (codec, bitrate, resolution) | Yes | No | No | No | Partial | Some audio |
| Federation between servers | Yes, between Backspace instances | No | No | No | Yes, open standard | No |
| Native mobile apps | Installable PWA | Yes | Yes | Desktop client only | Yes | Yes |
| Runs on a Raspberry Pi | Yes (prebuilt arm64 image) | No | Yes | Yes | Yes | Yes |

"Partial" and "Limited" mean the capability exists but is less complete or less
polished than the leaders in that row at the time of writing. Check the current
state of each project.

## Backspace vs Discord

Discord is the reference experience and has the ecosystem, the bots, and the user
base. It is also proprietary, you cannot host it, and you do not own the data or
the moderation policy. Backspace exists for the people who want the Discord shape
without giving up ownership. You trade the ecosystem and the network effect for
control of the server, the data, and the rules. If you want the biggest community
and the deepest bot ecosystem, use Discord. If you want to own your instance, use
Backspace.

## Backspace vs Revolt

Revolt is the closest peer: an open-source, self-hostable, Discord-style chat with
an active community and a Rust backend. The main differences are the media stack
and federation. Backspace is built around a full voice and video control surface
(per-stream codec, bitrate, and resolution, RNNoise, a live connection inspector,
screen share up to 4K/120fps within admin limits) and supports peering independent
instances. If high-quality voice and screen sharing or cross-instance federation
are central to you, Backspace is aimed squarely at that. If you want a larger
existing community and a longer track record, look at Revolt.

## Backspace vs Spacebar

Spacebar reimplements the Discord backend so the actual Discord client can talk to
a server you host. That is a clever path to instant client familiarity, and it is
the right pick if using the real Discord app against your own backend is the goal.
The trade-off is that it inherits Discord's client and its constraints, and its
voice stack is still maturing. Backspace ships its own client and its own voice
and video stack, and it is federation-first rather than Discord-protocol-first.

## Backspace vs Matrix and Element

Matrix is the mature, standardized answer to open federation, and Element is its
best-known client. If interoperable, standards-based federation across many
different server and client implementations is your priority, Matrix is the
stronger choice and Backspace does not try to replace it. Backspace federation is
newer, simpler, and currently peers Backspace instances with each other rather
than speaking an open cross-ecosystem protocol. Where Backspace differs is the
experience: a tightly integrated Discord-style client with a purpose-built media
control surface, rather than a protocol with many clients of varying polish.

## Backspace vs Mumble

Mumble is outstanding at exactly one thing: low-latency voice for groups, self
hosted, lightweight. It has no rich text platform, no video, and no federation.
If all you need is the best self-hosted push-to-talk voice, Mumble is a great,
proven choice. Backspace is a full communication platform (text, voice, video,
files, social, federation) rather than a dedicated voice server, so pick it when
you want more than voice.
