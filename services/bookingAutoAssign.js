const Booking = require('../models/Booking');
const Product = require('../models/Product');
const User = require('../models/User');
const { todayKey, escapeHtml, formatDay } = require('../utils/format');
const { notifyUser } = require('../bot/notify');

/**
 * Auto-assignment of confirmed bookings.
 *
 * Once an admin confirms a booking, the instrument should end up in the
 * booker's hands on the booked day without anyone having to tap Occupy:
 *
 *  - Booking confirmed for TODAY and the item is free  → assigned on the spot
 *    (approvals.js calls fulfillBooking directly).
 *  - Booking confirmed for a FUTURE day                → the scheduler below
 *    assigns it when that day arrives.
 *  - Item still out with someone else on the day       → it is handed to the
 *    booker the moment it is submitted back (occupancy.releaseProduct calls
 *    autoAssignForProductToday).
 *
 * fulfilledAt on the booking records that the hand-over happened, so a
 * booking is never assigned twice.
 */

/**
 * Hand the instrument to the booker and stamp the booking as fulfilled.
 * Assumes the caller has checked the product is actually free.
 * Pass notify: false when the caller sends its own combined message.
 */
async function fulfillBooking(booking, product, user, { notify = true } = {}) {
  // Lazy require: occupancy.js also requires this file on release
  const { occupyProduct } = require('./occupancy');

  await occupyProduct({ product, user, reason: booking.reason, source: 'auto' });

  booking.fulfilledAt = new Date();
  await booking.save();

  if (notify && user.telegramChatId) {
    notifyUser(
      user.telegramChatId,
      `⚡ <b>Your booking is live!</b> <b>${escapeHtml(product.name)}</b> ` +
        `<code>${escapeHtml(product.assetTag)}</code> was booked for you for ` +
        `<b>${escapeHtml(formatDay(booking.bookedFor))}</b> and has been assigned to you automatically.\n` +
        (booking.reason ? `📝 For: ${escapeHtml(booking.reason)}\n` : '') +
        `\nTap <b>Submit item</b> in /mine when you bring it back.`
    );
  }

  return booking;
}

/**
 * Called by occupancy.releaseProduct right after an item comes back:
 * if someone holds a confirmed booking for this item for TODAY, hand it
 * straight to them. Returns the fulfilled booking, or null.
 */
async function autoAssignForProductToday(product) {
  if (product.assignedTo) return null;
  if (product.status !== 'available') return null; // e.g. went to maintenance

  const booking = await Booking.findOne({
    product: product._id,
    bookedFor: todayKey(),
    status: 'confirmed',
    fulfilledAt: null,
  }).sort({ createdAt: 1 });
  if (!booking) return null;

  const user = await User.findById(booking.user);
  if (!user || user.status !== 'active') return null;

  try {
    return await fulfillBooking(booking, product, user);
  } catch (err) {
    console.error(`Could not hand ${product.assetTag} to booker ${booking.userName}:`, err.message);
    return null;
  }
}

/**
 * The scheduler pass: every confirmed booking whose day is today and which
 * has not been fulfilled yet gets a hand-over attempt. Items that are still
 * out with someone else are left alone — releaseProduct picks those up the
 * moment they come back.
 */
async function autoAssignDueBookings() {
  const key = todayKey();
  const due = await Booking.find({
    status: 'confirmed',
    bookedFor: key,
    fulfilledAt: null,
  }).sort({ createdAt: 1 });

  let assigned = 0;
  for (const booking of due) {
    try {
      const product = await Product.findById(booking.product);
      if (!product) continue;

      // Already in the booker's hands (they occupied it themselves)? Done.
      if (product.assignedTo && String(product.assignedTo) === String(booking.user)) {
        booking.fulfilledAt = new Date();
        await booking.save();
        continue;
      }

      // Out with someone else → wait for the return (release handles it)
      if (product.assignedTo) continue;

      // Not takeable right now
      if (
        product.condition === 'retired' ||
        product.condition === 'needs-repair' ||
        product.status === 'maintenance'
      )
        continue;

      const user = await User.findById(booking.user);
      if (!user || user.status !== 'active') continue;

      await fulfillBooking(booking, product, user);
      assigned += 1;
    } catch (err) {
      console.error(`Auto-assign failed for booking ${booking._id}:`, err.message);
    }
  }
  return assigned;
}

/**
 * Start the background loop: one pass right away (covers bookings whose day
 * arrived while the server was down), then every 5 minutes. The day key is
 * computed on each pass, so the loop naturally picks up the date change at
 * midnight in the configured timezone.
 */
let timer = null;
let running = false;

function startBookingScheduler(intervalMs = 5 * 60 * 1000) {
  if (timer) return timer;

  const pass = async () => {
    if (running) return; // never overlap two passes
    running = true;
    try {
      const n = await autoAssignDueBookings();
      if (n > 0) console.log(`Booking auto-assign: handed out ${n} instrument(s)`);
    } catch (err) {
      console.error('Booking auto-assign pass failed:', err.message);
    } finally {
      running = false;
    }
  };

  // Small delay so the DB connection is up before the first pass
  setTimeout(pass, 10 * 1000);
  timer = setInterval(pass, intervalMs);
  return timer;
}

module.exports = {
  fulfillBooking,
  autoAssignForProductToday,
  autoAssignDueBookings,
  startBookingScheduler,
};
