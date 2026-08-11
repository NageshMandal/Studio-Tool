const TelegramBot = require('node-telegram-bot-api');
const { handleMessage, handleCallback } = require('./handlers');

/**
 * Starts long polling. Returns null (and says why) when no token is set,
 * so the web app still runs perfectly well without the bot.
 */
function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('Telegram bot not started: TELEGRAM_BOT_TOKEN is not set in .env');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', (msg) => {
    handleMessage(bot, msg).catch((err) => {
      console.error('Bot message error:', err.message);
      bot.sendMessage(msg.chat.id, 'Something went wrong on our side. Send /start to begin again.').catch(() => {});
    });
  });

  bot.on('callback_query', (query) => {
    handleCallback(bot, query).catch((err) => {
      console.error('Bot callback error:', err.message);
      bot.answerCallbackQuery(query.id, { text: 'Something went wrong' }).catch(() => {});
    });
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

  bot.setMyCommands([
    { command: 'start', description: 'Sign in / open the menu' },
    { command: 'items', description: 'Browse categories' },
    { command: 'mine', description: 'What you are holding' },
    { command: 'logout', description: 'Sign out of this chat' },
    { command: 'help', description: 'How this works' },
  ]).catch(() => {});

  console.log('Telegram bot started (long polling)');
  return bot;
}

module.exports = { startBot };
