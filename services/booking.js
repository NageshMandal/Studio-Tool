const Booking = require('../models/Booking');
const User = require('../models/User');
const { todayKey, formatDay, escapeHtml, formatWhen } = require('../utils/format');
const { notifyUser, notifyAdmins } = require('../bot/notify');

/**
 * One place that files a booking, used by the Telegram bot and the staff
 * website so the rules never drift apart.
 *
 * EVERY booking — power and normal accounts alike — waits for an admin to
 * confirm or cancel it. What happens right after filing depends on where
 * the item is:
 *
 *  - Item on the shelf → the admins are notified immediately (Telegram card
 *    with ✅/❌ buttons, plus the panel's Requests page).
 *  - Item out with someone else → THAT PERSON is notified first: "X has
 *    booked this — submit it when your work is done." The admins are only
 *    notified once the item actually comes back (see occupancy service),
 *    so they confirm a booking for an item that is really there.
 *
 * Other rules: the day must be today or later; one live booking per person
 * per item per day; a day already confirmed for someone else cannot be
 * double-booked.
 */
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'Thu 20 Aug 10:00 → Fri 21 Aug 18:00' — omits whatever was not given. */
function bookingSpan(b) {
  let out = formatDay(b.bookedFor);
  if (b.pickupTime) out += ` ${b.pickupTime}`;
  if (b.dropDate || b.dropTime) {
    out += ' → ';
    out += b.dropDate && b.dropDate !== b.bookedFor ? `${formatDay(b.dropDate)} ` : '';
    out += b.dropTime || '';
    out = out.trimEnd();
  }
  return out;
}

async function createBooking({ product, user, dateKey, reason, pickupTime, dropDate, dropTime, source = 'telegram' }) {
  if (!dateKey || dateKey < todayKey()) {
    const err = new Error('Bookings must be for today or a future date');
    err.code = 'PAST_DATE';
    throw err;
  }

  // Pickup / drop details are optional (the Telegram bot only asks for a
  // date) but must be sensible when given.
  pickupTime = (pickupTime || '').trim() || null;
  dropDate = (dropDate || '').trim() || null;
  dropTime = (dropTime || '').trim() || null;
  if (pickupTime && !TIME_RE.test(pickupTime)) {
    const err = new Error('Pickup time must look like 10:30');
    err.code = 'BAD_TIME';
    throw err;
  }
  if (dropTime && !TIME_RE.test(dropTime)) {
    const err = new Error('Drop time must look like 18:00');
    err.code = 'BAD_TIME';
    throw err;
  }
  if (dropDate && !DATE_RE.test(dropDate)) {
    const err = new Error('Pick a valid drop date');
    err.code = 'BAD_DATE';
    throw err;
  }
  if (dropDate && dropDate < dateKey) {
    const err = new Error('The drop date cannot be before the pickup date');
    err.code = 'DROP_BEFORE_PICKUP';
    throw err;
  }
  if (dropDate === dateKey && pickupTime && dropTime && dropTime <= pickupTime) {
    const err = new Error('The drop time must be after the pickup time');
    err.code = 'DROP_BEFORE_PICKUP';
    throw err;
  }

  if (product.condition === 'retired') {
    const err = new Error('This item is retired and cannot be booked');
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

  // Is the item out with someone else right now?
  const heldByOther = !!(product.assignedTo && String(product.assignedTo) !== String(user._id));

  const booking = await Booking.create({
    product: product._id,
    productName: product.name,
    assetTag: product.assetTag,
    imageUrl: product.imageUrl || null,
    user: user._id,
    userName: user.name,
    bookedFor: dateKey,
    pickupTime,
    dropDate,
    dropTime,
    reason: (reason || '').trim().slice(0, 120) || null,
    status: 'pending',
    awaitingReturn: heldByOther,
    source,
  });

  let holder = null;
  if (heldByOther) {
    // Ask the current holder to bring it back — the admins wait their turn
    holder = await User.findById(product.assignedTo).lean();
    if (holder && holder.telegramChatId) {
      notifyUser(
        holder.telegramChatId,
        `📦 <b>${escapeHtml(user.name)}</b> has booked <b>${escapeHtml(product.name)}</b> ` +
          `<code>${escapeHtml(product.assetTag)}</code> for <b>${escapeHtml(bookingSpan(booking))}</b>.\n` +
          (booking.reason ? `📝 ${escapeHtml(booking.reason)}\n` : '') +
          `You have had it since ${formatWhen(product.occupiedAt)}.\n\n` +
          `Please <b>submit it when your work is done</b> — the admin will confirm the booking once it is back.`,
        {
          inline_keyboard: [[{ text: '✅ Submit item now', callback_data: `ret:${product._id}` }]],
        }
      );
    }
  } else {
    // Item is on the shelf: admins can decide straight away
    notifyAdminsAboutBooking(booking);
  }

  const out = booking.toObject();
  out.holderNameAtCreation = holder ? holder.name : null;
  return out;
}

// The Telegram card every admin gets, with one-tap decision buttons
function notifyAdminsAboutBooking(booking, itemJustReturned = false) {
  notifyAdmins(
    `📅 <b>${escapeHtml(booking.userName)}</b> wants to book ` +
      `<b>${escapeHtml(booking.productName)}</b> <code>${escapeHtml(booking.assetTag || '')}</code> ` +
      `for <b>${escapeHtml(bookingSpan(booking))}</b>.\n` +
      (booking.reason ? `📝 ${escapeHtml(booking.reason)}\n` : '') +
      (itemJustReturned ? `📦 The item has just been submitted and is back on the shelf.\n` : '') +
      `Tap to decide, or use the panel → Requests.`,
    {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `apbk:${booking._id}` },
          { text: '❌ Cancel booking', callback_data: `rjbk:${booking._id}` },
        ],
      ],
    }
  );
}

/**
 * Called by the occupancy service whenever an item comes back: any
 * bookings that were waiting for this return now go to the admins for a
 * decision — Telegram cards and the panel both.
 */
async function activateHeldBookings(product) {
  const held = await Booking.find({
    product: product._id,
    status: 'pending',
    awaitingReturn: true,
  }).sort({ bookedFor: 1 });

  for (const booking of held) {
    booking.awaitingReturn = false;
    await booking.save();
    notifyAdminsAboutBooking(booking, true);
  }

  return held.length;
}

module.exports = { createBooking, activateHeldBookings, notifyAdminsAboutBooking, bookingSpan };