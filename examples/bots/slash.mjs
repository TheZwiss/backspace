// Slash command bot: registers /play, /stop, /poke, /music and /purge and answers them.
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
      // Choices are suggestions: `volume:34` works too, within 0..100.
      { name: 'volume', description: 'Volume', type: 'integer', minValue: 0, maxValue: 100, choices: [{ name: 'low', value: 20 }, { name: 'high', value: 80 }] },
    ],
  },
  { name: 'stop', description: 'Stop playing' },
  {
    // Typed options: the person picks a user, a voice channel and a role; the
    // bot gets their ids in `options` and the objects in `resolved`.
    name: 'poke',
    description: 'Poke someone, somewhere',
    options: [
      { name: 'who', description: 'Who to poke', type: 'user', required: true },
      { name: 'times', description: 'How many times', type: 'integer', minValue: 1, maxValue: 5 },
      { name: 'where', description: 'A voice channel', type: 'channel', channelTypes: ['voice'] },
      { name: 'group', description: 'A role to name', type: 'role' },
      { name: 'loud', description: 'Shout it', type: 'boolean' },
      { name: 'note', description: 'A short note', type: 'string', minLength: 2, maxLength: 40 },
    ],
  },
  {
    // Subcommands: `/music play`, `/music queue add|list|clear`. The bot gets the
    // path in `interaction.subcommand` and that subcommand's values in `options`.
    name: 'music',
    description: 'A pretend music queue',
    options: [
      { name: 'play', description: 'Play a track now', type: 'subcommand', options: [
        { name: 'query', description: 'What to play', type: 'string', required: true },
      ] },
      { name: 'queue', description: 'The queue of this chat', type: 'subcommand_group', options: [
        { name: 'add', description: 'Add a track', type: 'subcommand', options: [
          { name: 'query', description: 'What to add', type: 'string', required: true },
          { name: 'times', description: 'How many times', type: 'integer', minValue: 1, maxValue: 3 },
        ] },
        { name: 'list', description: 'Show the queue', type: 'subcommand' },
        // Only those who may manage messages in the channel see and use this one.
        { name: 'clear', description: 'Empty the queue', type: 'subcommand', requiredPermissions: ['MANAGE_MESSAGES'] },
      ] },
    ],
  },
  {
    // A whole command for moderators: hidden from everyone else, and in direct messages.
    name: 'purge',
    description: 'Pretend to delete recent messages',
    requiredPermissions: ['MANAGE_MESSAGES'],
    options: [{ name: 'count', description: 'How many', type: 'integer', required: true, minValue: 1, maxValue: 100 }],
  },
];

/** The pretend queue of each chat, by channel or DM id. */
const queues = new Map();

bot.run(async (event) => {
  if (event.type === 'ready') {
    // The list is replaced as a whole, so doing this on every (re)connect is harmless.
    await bot.api('PUT', '/bots/@me/commands', { commands });
    console.log('commands registered');
    return;
  }
  if (event.type !== 'interaction_created') return;

  const { id, command, subcommand, options, resolved, user } = event.interaction;
  const answer = (content) => bot.api('POST', `/interactions/${id}/respond`, { content });
  // Seen only by the person who invoked the command, and not stored.
  const answerPrivately = (content) => bot.api('POST', `/interactions/${id}/respond`, { content, ephemeral: true });

  if (command === 'play') {
    await answer(`<@${user.id}> asked me to play "${options.query}" at volume ${options.volume ?? 'default'}`);
  } else if (command === 'stop') {
    await answer(`<@${user.id}> asked me to stop`);
  } else if (command === 'poke') {
    const target = resolved?.users?.[options.who];
    const where = options.where ? ` in #${resolved?.channels?.[options.where]?.name}` : '';
    const group = options.group ? ` (for ${resolved?.roles?.[options.group]?.name})` : '';
    const text = `poke ${target?.displayName ?? target?.username} x${options.times ?? 1}${where}${group}${options.note ? `: ${options.note}` : ''}`;
    await answer(options.loud ? text.toUpperCase() : text);
  } else if (command === 'purge') {
    await answerPrivately(`Would delete the last ${options.count} messages here (this example deletes nothing).`);
  } else if (command === 'music') {
    const chat = event.interaction.channelId ?? event.interaction.dmChannelId;
    if (!queues.has(chat)) queues.set(chat, []);
    const queue = queues.get(chat);
    const path = (subcommand ?? []).join(' ');
    if (path === 'play') {
      await answer(`now playing "${options.query}"`);
    } else if (path === 'queue add') {
      for (let i = 0; i < (options.times ?? 1); i++) queue.push(options.query);
      await answer(`queued "${options.query}" (${queue.length} in the queue)`);
    } else if (path === 'queue list') {
      if (queue.length === 0) await answerPrivately('The queue is empty.');
      else await answer(queue.map((title, i) => `${i + 1}. ${title}`).join('\n'));
    } else if (path === 'queue clear') {
      queue.length = 0;
      await answer('the queue is empty now');
    }
  }
});
