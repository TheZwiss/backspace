// Slash command bot: registers /play and /stop and answers them.
// The server carries the call; what a command does is decided here.
//
//   BACKSPACE_URL=https://chat.example.com BOT_TOKEN=... node examples/bots/slash.mjs
import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

const commands = [
  {
    name: 'play',
    description: 'Pretend to play a track',
    options: [
      { name: 'query', description: 'What to play', type: 'string', required: true },
      { name: 'volume', description: 'Volume', type: 'integer', choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
    ],
  },
  { name: 'stop', description: 'Stop playing' },
];

bot.run(async (event) => {
  if (event.type === 'ready') {
    // The list is replaced as a whole, so doing this on every (re)connect is harmless.
    await bot.api('PUT', '/bots/@me/commands', { commands });
    console.log('commands registered');
    return;
  }
  if (event.type !== 'interaction_created') return;

  const { id, command, options, user } = event.interaction;
  const answer = (content) => bot.api('POST', `/interactions/${id}/respond`, { content });

  if (command === 'play') {
    await answer(`<@${user.id}> asked me to play "${options.query}" at volume ${options.volume ?? 'default'}`);
  } else if (command === 'stop') {
    await answer(`<@${user.id}> asked me to stop`);
  }
});
