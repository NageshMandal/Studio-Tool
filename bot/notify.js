/**
 * A tiny bridge between the web app and the Telegram bot.
 *
 * The bot instance is registered once at startup. Any controller or service
 * can then push messages: notifyUser() for one chat, and — the important one
 * in a multi-studio setup — notifyLocationAdmins() for the admins of ONE
 * studio.
 *
 * Broadcasting to every admin everywhere would mean the Kolkata admin's
 * phone buzzing for a Patna camera, so the studio-scoped version is the
 * default and notifyAllAdmins() is reserved for genuinely global news.
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

/** Send the same message to a set of chat ids, collapsing duplicates. */
async function fanOut(chatIds, text, keyboard) {
  let sent = 0;
  for (const chatId of new Set(chatIds.filter(Boolean).map(String))) {
    if (await notifyUser(chatId, text, keyboard)) sent += 1;
  }
  return sent;
}

/**
 * The admins responsible for ONE studio: its location admin and its
 * managers. The root admin's own chat (ADMIN_TELEGRAM_CHAT_ID) is
 * deliberately NOT included — a studio's day-to-day traffic is not the
 * super admin's inbox.
 */
async function notifyLocationAdmins(locationId, text, keyboard = null) {
  if (!botInstance || !locationId) return 0;

  const Admin = require('../models/Admin');
  try {
    const admins = await Admin.find(
      {
        location: locationId,
        status: 'active',
        role: { $in: ['location_admin', 'location_sub_admin'] },
        telegramChatId: { $ne: null },
      },
      'telegramChatId'
    ).lean();
    return await fanOut(
      admins.map((a) => a.telegramChatId),
      text,
      keyboard
    );
  } catch (err) {
    console.error('Could not load studio admin chat list:', err.message);
    return 0;
  }
}

/**
 * Every super admin, plus the root admin's chat from `.env`. For news that
 * genuinely concerns the whole company rather than one studio.
 */
async function notifySuperAdmins(text, keyboard = null) {
  if (!botInstance) return 0;

  const Admin = require('../models/Admin');
  const chatIds = [];
  if (process.env.ADMIN_TELEGRAM_CHAT_ID) chatIds.push(process.env.ADMIN_TELEGRAM_CHAT_ID);
  try {
    const supers = await Admin.find(
      { role: 'super', status: 'active', telegramChatId: { $ne: null } },
      'telegramChatId'
    ).lean();
    supers.forEach((a) => chatIds.push(a.telegramChatId));
  } catch (err) {
    console.error('Could not load super admin chat list:', err.message);
  }
  return fanOut(chatIds, text, keyboard);
}

/**
 * Kept for the few callers that genuinely have no studio in hand. Prefer
 * notifyLocationAdmins wherever a location is known.
 */
async function notifyAllAdmins(text, keyboard = null) {
  if (!botInstance) return 0;

  const Admin = require('../models/Admin');
  const chatIds = [];
  if (process.env.ADMIN_TELEGRAM_CHAT_ID) chatIds.push(process.env.ADMIN_TELEGRAM_CHAT_ID);
  try {
    const admins = await Admin.find(
      { status: 'active', telegramChatId: { $ne: null } },
      'telegramChatId'
    ).lean();
    admins.forEach((a) => chatIds.push(a.telegramChatId));
  } catch (err) {
    console.error('Could not load admin chat list:', err.message);
  }
  return fanOut(chatIds, text, keyboard);
}

module.exports = {
  registerBot,
  botIsRunning,
  notifyUser,
  notifyLocationAdmins,
  notifySuperAdmins,
  notifyAllAdmins,
  // Older name, now studio-aware where a location is passed
  notifyAdmins: notifyAllAdmins,
};
