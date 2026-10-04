// Voice bot skeleton: the Backspace side of a bot that sits in SEVERAL voice
// channels at once, one seat per channel, so one radio bot is never shared
// between channels. It does NOT produce audio: where marked below, connect to
// the LiveKit room with the LiveKit client library of your choice, one
// connection per channel, and publish that channel's audio track.
//
//   BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/voice.mjs
//
// /radio <station>  joins the voice channel the person is in and starts that station there
// /leave            leaves the voice channel the person is in (the bot's other seats stay)
import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

const seats = new Map();    // user id -> voice channel id they sit in, kept from the voice events
const players = new Map();  // voice channel id -> { station, url, token }, one entry per seat of the bot

const commands = [
  {
    name: 'radio',
    description: 'Join your voice channel and play a station',
    options: [{ name: 'station', description: 'Which station', type: 'string', required: true }],
  },
  { name: 'leave', description: 'Leave your voice channel' },
];

bot.run(async (event) => {
  if (event.type === 'ready') {
    // After a reconnect the server has already taken the bot out of every voice
    // channel, so nothing here is playing any more.
    players.clear();
    seats.clear();
    for (const [channelId, userIds] of Object.entries(event.voiceStates ?? {})) {
      for (const userId of userIds) seats.set(userId, channelId);
    }
    await bot.api('PUT', '/bots/@me/commands', { commands });
    return;
  }

  if (event.type === 'voice_state_update') {
    if (event.action === 'join') seats.set(event.userId, event.channelId);
    else if (seats.get(event.userId) === event.channelId) seats.delete(event.userId);
    return;
  }

  if (event.type !== 'interaction_created') return;
  const { id, command, options, user } = event.interaction;
  const answer = (content) => bot.api('POST', `/interactions/${id}/respond`, { content });
  const channelId = seats.get(user.id);

  if (!channelId) {
    await answer(`<@${user.id}> join a voice channel first`);
    return;
  }

  if (command === 'radio') {
    bot.send({ type: 'bot_voice_join', channelId });             // a seat of its own, the others stay
    const { token, url } = await bot.api('POST', '/livekit/token', { channelId });
    players.set(channelId, { station: options.station, url, token });
    // Connect to the LiveKit room here: `url` and `token` are for THIS channel only.
    // One room connection per entry of `players`, each publishing its own audio.
    await answer(`<@${user.id}> now playing ${options.station} in your channel (${players.size} voice channel(s) in use)`);
  } else if (command === 'leave') {
    bot.send({ type: 'bot_voice_leave', channelId });
    players.delete(channelId);
    await answer(`<@${user.id}> left your channel`);
  }
});
