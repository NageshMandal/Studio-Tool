const Notification = require('../models/Notification');
const { notifyUser } = require('../bot/notify');

/**
 * The one place a staff member is told something.
 *
 * Every call does two things: it writes a row the person will see on their
 * dashboard next time they open it, and it pushes the same news to their
 * Telegram chat if they have linked one. The dashboard copy is the reliable
 * half — Telegram is best-effort and stays that way.
 *
 * Nothing here throws. A notification failing must never roll back the
 * decision that caused it: the admin's approve/decline has already been
 * saved by the time we get here.
 */

/**
 * @param {Object} user           A User document (needs _id and telegramChatId)
 * @param {String} telegramText   HTML-formatted message for Telegram
 * @param {Object} fields         The rest of the Notification fields
 */
async function pushNotification({ user, telegramText, ...fields }) {
  if (!user) return null;

  // Telegram first, so we can record whether it actually landed
  let sentToTelegram = false;
  if (telegramText && user.telegramChatId) {
    try {
      sentToTelegram = await notifyUser(user.telegramChatId, telegramText);
    } catch (err) {
      console.error('Telegram push failed:', err.message);
    }
  }

  try {
    return await Notification.create({ ...fields, user: user._id, sentToTelegram });
  } catch (err) {
    console.error('Could not save staff notification:', err.message);
    return null;
  }
}

/** Unread count for the sidebar badge. Falls back to 0 rather than failing a page. */
async function unreadCount(userId) {
  try {
    return await Notification.countDocuments({ user: userId, readAt: null });
  } catch (err) {
    console.error('Could not count notifications:', err.message);
    return 0;
  }
}

/**
 * What the dashboard shows: everything still unread, plus a short tail of
 * recently dismissed ones so the panel is not empty the moment it is cleared.
 */
async function listForStaff(userId, { readTail = 5 } = {}) {
  try {
    const [unread, recentlyRead] = await Promise.all([
      Notification.find({ user: userId, readAt: null }).sort({ createdAt: -1 }).limit(30).lean(),
      Notification.find({ user: userId, readAt: { $ne: null } })
        .sort({ readAt: -1 })
        .limit(readTail)
        .lean(),
    ]);
    return { unread, recentlyRead };
  } catch (err) {
    console.error('Could not load notifications:', err.message);
    return { unread: [], recentlyRead: [] };
  }
}

/** Dismiss one. Scoped to the owner so an id from elsewhere does nothing. */
async function markRead(notificationId, userId) {
  try {
    const result = await Notification.updateOne(
      { _id: notificationId, user: userId, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return result.modifiedCount > 0;
  } catch (err) {
    console.error('Could not mark notification read:', err.message);
    return false;
  }
}

/** Dismiss all of mine at once. Returns how many were cleared. */
async function markAllRead(userId) {
  try {
    const result = await Notification.updateMany(
      { user: userId, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return result.modifiedCount || 0;
  } catch (err) {
    console.error('Could not clear notifications:', err.message);
    return 0;
  }
}

module.exports = { pushNotification, unreadCount, listForStaff, markRead, markAllRead };
