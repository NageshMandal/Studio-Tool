const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const Product = require('../models/Product');
const User = require('../models/User');
const { occupyProduct } = require('./occupancy');
const { notifyUser } = require('../bot/notify');
const { escapeHtml, todayKey, formatDay } = require('../utils/format');
const { bookingSpan } = require('./booking');

/**
 * The one place a request or booking gets decided, used by the admin panel
 * AND the approve/decline buttons in the admins' Telegram chats. Both roads
 * run the same checks, write the same fields, and message the person the
 * same way — and a request that has already been decided cannot be decided
 * again from the other side.
 *
 * Every function returns { ok, message } for the caller to show; it never
 * throws for a business-rule failure, only for genuine server errors.
 */

/* ---------------- occupy requests ---------------- */

async function approveRequest(requestId, decidedBy) {
  const request = await AssignmentRequest.findOne({ _id: requestId, status: 'pending' });
  if (!request) return { ok: false, message: 'That request has already been dealt with' };

  const product = await Product.findById(request.product);
  const user = await User.findById(request.user);

  // The world may have moved on since the request was made
  let failure = null;
  if (!product) failure = 'The item no longer exists';
  else if (!user || user.status !== 'active') failure = 'The person is no longer active';
  else if (product.assignedTo) failure = 'The item is already with someone else';
  else if (product.condition === 'retired') failure = 'The item has been retired';
  else if (product.status === 'maintenance' || product.condition === 'needs-repair') failure = 'The item is in maintenance';

  if (failure) {
    request.status = 'rejected';
    request.decidedAt = new Date();
    request.decisionNote = failure;
    request.decidedBy = decidedBy || null;
    await request.save();

    if (user && user.telegramChatId) {
      notifyUser(
        user.telegramChatId,
        `❌ Your request for <b>${escapeHtml(request.productName)}</b> <code>${escapeHtml(request.assetTag || '')}</code> could not be approved.\n📝 ${escapeHtml(failure)}.`
      );
    }
    return { ok: false, message: `Could not approve: ${failure}` };
  }

  // Same path as a bot occupy, so the usage log never misses a movement
  await occupyProduct({ product, user, reason: request.reason, source: 'admin' });

  request.status = 'approved';
  request.decidedAt = new Date();
  request.decidedBy = decidedBy || null;
  await request.save();

  if (user.telegramChatId) {
    notifyUser(
      user.telegramChatId,
      `✅ <b>Approved!</b> The admin has assigned <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> to you.\n` +
        (request.reason ? `📝 For: ${escapeHtml(request.reason)}\n` : '') +
        `\nIt is now with you — tap <b>Submit item</b> in /mine when you bring it back.`
    );
  }

  return { ok: true, message: `Approved — ${product.name} is now with ${user.name}`, request };
}

async function rejectRequest(requestId, decidedBy, note) {
  const request = await AssignmentRequest.findOne({ _id: requestId, status: 'pending' });
  if (!request) return { ok: false, message: 'That request has already been dealt with' };

  const cleanNote = (note || '').trim().slice(0, 200) || null;

  request.status = 'rejected';
  request.decidedAt = new Date();
  request.decisionNote = cleanNote;
  request.decidedBy = decidedBy || null;
  await request.save();

  const user = await User.findById(request.user);
  if (user && user.telegramChatId) {
    notifyUser(
      user.telegramChatId,
      `❌ Your request for <b>${escapeHtml(request.productName)}</b> <code>${escapeHtml(request.assetTag || '')}</code> was declined by the admin.` +
        (cleanNote ? `\n📝 ${escapeHtml(cleanNote)}` : '')
    );
  }

  return { ok: true, message: 'Request declined', request };
}

/* ---------------- bookings ---------------- */

async function approveBooking(bookingId, decidedBy) {
  const booking = await Booking.findOne({ _id: bookingId, status: 'pending' });
  if (!booking) return { ok: false, message: 'That booking has already been dealt with' };

  const user = await User.findById(booking.user);
  const product = await Product.findById(booking.product);

  let failure = null;
  if (!product) failure = 'The item no longer exists';
  else if (!user || user.status !== 'active') failure = 'The person is no longer active';
  else if (product.condition === 'retired') failure = 'The item has been retired';
  else if (booking.bookedFor < todayKey()) failure = 'The booked day has already passed';
  else {
    const clash = await Booking.findOne({
      product: booking.product,
      bookedFor: booking.bookedFor,
      status: 'confirmed',
      _id: { $ne: booking._id },
    }).lean();
    if (clash) failure = `That day is already booked by ${clash.userName}`;
  }

  if (failure) {
    booking.status = 'declined';
    booking.decidedAt = new Date();
    booking.decisionNote = failure;
    booking.decidedBy = decidedBy || null;
    await booking.save();

    if (user && user.telegramChatId) {
      notifyUser(
        user.telegramChatId,
        `❌ Your booking for <b>${escapeHtml(booking.productName)}</b> on <b>${escapeHtml(formatDay(booking.bookedFor))}</b> could not be approved.\n📝 ${escapeHtml(failure)}.`
      );
    }
    return { ok: false, message: `Could not approve booking: ${failure}` };
  }

  booking.status = 'confirmed';
  booking.decidedAt = new Date();
  booking.decidedBy = decidedBy || null;
  await booking.save();

  // If the booking is for TODAY and the item is free, don't make the
  // person come and occupy it — hand it to them right now. Future days are
  // handled by the scheduler; an item still out with someone else is handed
  // over the moment it comes back (see services/bookingAutoAssign.js).
  let autoAssigned = false;
  const canAssignNow =
    booking.bookedFor === todayKey() &&
    !product.assignedTo &&
    product.status !== 'maintenance' &&
    product.condition !== 'needs-repair';

  if (canAssignNow) {
    try {
      const { fulfillBooking } = require('./bookingAutoAssign');
      await fulfillBooking(booking, product, user, { notify: false });
      autoAssigned = true;
    } catch (err) {
      console.error(`Could not auto-assign booking ${booking._id}:`, err.message);
    }
  } else if (booking.bookedFor === todayKey() && product.assignedTo && String(product.assignedTo) === String(user._id)) {
    // The booker already has it in hand — nothing to hand over
    booking.fulfilledAt = new Date();
    await booking.save();
    autoAssigned = true;
  }

  if (user.telegramChatId) {
    notifyUser(
      user.telegramChatId,
      autoAssigned
        ? `✅ <b>Booking confirmed!</b> <b>${escapeHtml(booking.productName)}</b> <code>${escapeHtml(booking.assetTag || '')}</code> is for <b>today</b> — it has been <b>assigned to you</b> automatically.\n` +
            (booking.reason ? `📝 For: ${escapeHtml(booking.reason)}\n` : '') +
            `\nTap <b>Submit item</b> in /mine when you bring it back.`
        : `✅ <b>Booking confirmed!</b> <b>${escapeHtml(booking.productName)}</b> <code>${escapeHtml(booking.assetTag || '')}</code> is reserved for you: <b>${escapeHtml(bookingSpan(booking))}</b>.\n` +
            (booking.reason ? `📝 For: ${escapeHtml(booking.reason)}\n` : '') +
            `\nIt will be assigned to you automatically on the day.`
    );
  }

  return {
    ok: true,
    message: autoAssigned
      ? `Booking confirmed — ${booking.productName} is now with ${booking.userName}`
      : `Booking confirmed — ${booking.productName} on ${formatDay(booking.bookedFor)} for ${booking.userName}`,
    booking,
  };
}

async function rejectBooking(bookingId, decidedBy, note) {
  const booking = await Booking.findOne({ _id: bookingId, status: 'pending' });
  if (!booking) return { ok: false, message: 'That booking has already been dealt with' };

  const cleanNote = (note || '').trim().slice(0, 200) || null;

  booking.status = 'declined';
  booking.decidedAt = new Date();
  booking.decisionNote = cleanNote;
  booking.decidedBy = decidedBy || null;
  await booking.save();

  const user = await User.findById(booking.user);
  if (user && user.telegramChatId) {
    notifyUser(
      user.telegramChatId,
      `❌ Your booking for <b>${escapeHtml(booking.productName)}</b> on <b>${escapeHtml(formatDay(booking.bookedFor))}</b> was declined by the admin.` +
        (cleanNote ? `\n📝 ${escapeHtml(cleanNote)}` : '')
    );
  }

  return { ok: true, message: 'Booking declined', booking };
}

module.exports = { approveRequest, rejectRequest, approveBooking, rejectBooking };