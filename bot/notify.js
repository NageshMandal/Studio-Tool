/**
 * A tiny bridge between the web app and the Telegram bot.
 *
 * The bot instance is registered once at startup. Any controller or service
 * can then push messages: notifyUser() for one chat, notifyAdmins() for every
 * signed-in admin at once (new requests, new bookings), optionally with
 * inline approve/decline buttons.
 *
 * Everything here fails quietly: no bot running, no linked chat, or a
 * Telegram error must never break a web action.
 */

let botInstance = null;

function registerBot(bot) {
  botInstance = bot;
}

function botIsRunning() {
  return !!botInstance;
}

/**
 * Send an HTML-formatted message to a chat, optionally with an inline
 * keyboard. Resolves true when the message went out. Never throws.
 */
async function notifyUser(chatId, text, keyboard = null) {
  if (!botInstance || !chatId) return false;
  try {
    const opts = {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (keyboard) opts.reply_markup = keyboard;
    await botInstance.sendMessage(String(chatId), text, opts);
    return true;
  } catch (err) {
    console.error('Telegram notify failed:', err.message);
    return false;
  }
}

/**
 * Broadcast to every admin who can hear it: each active admin account linked
 * to a Telegram chat, plus the optional ADMIN_TELEGRAM_CHAT_ID from `.env`
 * (the root admin's own chat). Duplicates are collapsed.
 */
async function notifyAdmins(text, keyboard = null) {
  if (!botInstance) return 0;

  // Required lazily to avoid a cycle at module load time
  const Admin = require('../models/Admin');

  const chatIds = new Set();
  if (process.env.ADMIN_TELEGRAM_CHAT_ID) chatIds.add(String(process.env.ADMIN_TELEGRAM_CHAT_ID));
  try {
    const admins = await Admin.find(
      { status: 'active', telegramChatId: { $ne: null } },
      'telegramChatId'
    ).lean();
    admins.forEach((a) => chatIds.add(String(a.telegramChatId)));
  } catch (err) {
    console.error('Could not load admin chat list:', err.message);
  }

  let sent = 0;
  for (const chatId of chatIds) {
    if (await notifyUser(chatId, text, keyboard)) sent += 1;
  }
  return sent;
}

module.exports = { registerBot, botIsRunning, notifyUser, notifyAdmins };
