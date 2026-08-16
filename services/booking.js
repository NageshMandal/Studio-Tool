const Booking = require('../models/Booking');
const { todayKey, formatDay, escapeHtml } = require('../utils/format');
const { notifyAdmins } = require('../bot/notify');

/**
 * One place that files a booking, used by the Telegram bot and the staff
 * website so the rules never drift apart:
 *
 *  - the day must be today or later (no booking the past);
 *  - one live booking per person per item per day;
 *  - a day already confirmed for someone else cannot be double-booked;
 *  - power users are confirmed instantly, normal users wait for the admin.
 *
 * Throws with a `code` so callers can phrase the message for their medium.
 */
async function createBooking({ product, user, dateKey, reason, source = 'telegram' }) {
  if (!dateKey || dateKey < todayKey()) {
    const err = new Error('Bookings must be for today or a future date');
    err.code = 'PAST_DATE';
    throw err;
  }
  if (product.condition === 'retired') {
    const err = new Error('This instrument is retired and cannot be booked');
    err.code = 'RETIRED';
    throw err;
  }

  const clash = await Booking.findOne({
    product: product._id,
    bookedFor: dateKey,
    status: 'confirmed',
  }).lean();
  if (clash) {
    const err = new Error(`Already booked by ${clash.userName} for ${formatDay(dateKey)}`);
    err.code = 'DAY_TAKEN';
    err.bookedBy = clash.userName;
    throw err;
  }

  const duplicate = await Booking.findOne({
    product: product._id,
    user: user._id,
    bookedFor: dateKey,
    status: { $in: ['pending', 'confirmed'] },
  }).lean();
  if (duplicate) {
    const err = new Error('You already have a booking for this item on that day');
    err.code = 'DUPLICATE';
    err.existingStatus = duplicate.status;
    throw err;
  }

  const isPower = user.accountType === 'power';
  const booking = await Booking.create({
    product: product._id,
    productName: product.name,
    assetTag: product.assetTag,
    imageUrl: product.imageUrl || null,
    user: user._id,
    userName: user.name,
    bookedFor: dateKey,
    reason: (reason || '').trim().slice(0, 120) || null,
    status: isPower ? 'confirmed' : 'pending',
    source,
  });

  // Every signed-in admin hears about a pending booking, with decision buttons
  if (!isPower) {
    notifyAdmins(
      `📅 <b>${escapeHtml(booking.userName)}</b> wants to book ` +
        `<b>${escapeHtml(booking.productName)}</b> <code>${escapeHtml(booking.assetTag || '')}</code> ` +
        `for <b>${escapeHtml(formatDay(dateKey))}</b>.\n` +
        (booking.reason ? `📝 ${escapeHtml(booking.reason)}\n` : '') +
        `Tap to decide, or use the panel → Requests.`,
      {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `apbk:${booking._id}` },
            { text: '❌ Decline', callback_data: `rjbk:${booking._id}` },
          ],
        ],
      }
    );
  }

  return booking;
}

module.exports = { createBooking };
