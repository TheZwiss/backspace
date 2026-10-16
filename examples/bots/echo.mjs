// Echo bot: repeats what people send it in direct messages.
// Behaviour lives here, not on the server: the server delivers every event the
// bot may see and the code decides what to do with it.
import { createBot } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });

bot.run(async (event) => {
  if (event.type !== 'dm_message_created') return;
  const { message } = event;
  // Its own messages come back as events; another bot's could start an endless exchange.
  if (message.userId === bot.me?.id || message.user?.isBot || message.type !== 'user' || !message.content) return;
  await bot.api('POST', `/dm/${message.dmChannelId}/messages`, { content: `you said: ${message.content}` });
});
