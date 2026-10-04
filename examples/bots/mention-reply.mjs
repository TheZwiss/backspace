// Answers only when it is mentioned in a space channel or a group DM, and
// answers every message in a 1-on-1 DM. That is a choice of THIS bot; another
// bot may behave differently on the same events.
import { createBot, mentions } from './client.mjs';

const bot = createBot({ baseUrl: process.env.BACKSPACE_URL, token: process.env.BOT_TOKEN });
const oneOnOne = new Set();   // DM channel ids known to be 1-on-1 (no owner)

bot.run(async (event) => {
  if (event.type === 'ready') {
    for (const dm of event.dmChannels ?? []) if (!dm.ownerId) oneOnOne.add(dm.id);
    return;
  }
  if (event.type === 'dm_channel_created' && !event.dmChannel.ownerId) {
    oneOnOne.add(event.dmChannel.id);
    return;
  }

  if (event.type === 'message_created') {
    const { message } = event;
    if (message.userId === bot.me.id || !mentions(message.content, bot.me.id)) return;
    await bot.api('POST', `/channels/${message.channelId}/messages`, {
      content: 'You called?',
      replyToId: message.id,
    });
    return;
  }

  if (event.type === 'dm_message_created') {
    const { message } = event;
    if (message.userId === bot.me.id || message.type !== 'user') return;
    if (!oneOnOne.has(message.dmChannelId) && !mentions(message.content, bot.me.id)) return;
    await bot.api('POST', `/dm/${message.dmChannelId}/messages`, {
      content: 'You called?',
      replyToId: message.id,
    });
  }
});
