// Reacts with a thumbs-up to every channel message that contains "!ok".
// Shows the REST reaction call; nothing is posted.
import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

bot.run(async (event) => {
  if (event.type !== 'message_created') return;
  const { message } = event;
  if (message.userId === bot.me.id || !message.content?.includes('!ok')) return;
  await bot.api('PUT', `/messages/${message.id}/reactions/${encodeURIComponent('👍')}`);
});
