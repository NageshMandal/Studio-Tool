const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const Product = require('../models/Product');
const User = require('../models/User');
const approvals = require('../services/approvals');
const { notifyUser } = require('../bot/notify');
const { escapeHtml, todayKey, formatDay } = require('../utils/format');

/**
 * Approval queue for normal users' item requests.
 *
 * A normal account can only *ask* for an item from the Telegram bot.
 * The request lands here; approving it performs the same occupy as the
 * product edit form (so the usage log stays complete) and the bot messages
 * the person either way.
 */

// GET /admin/requests
exports.list = async (req, res, next) => {
  try {
    const pending = await AssignmentRequest.find({ status: 'pending' })
      .sort({ createdAt: 1 }) // oldest first — first come, first served
      .lean();

    const decided = await AssignmentRequest.find({ status: { $ne: 'pending' } })
      .sort({ decidedAt: -1 })
      .limit(20)
      .lean();

    // Flag any pending request whose item has since become unavailable
    const productIds = [...new Set(pending.map((r) => String(r.product)))];
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    const productMap = products.reduce((acc, p) => ({ ...acc, [String(p._id)]: p }), {});
    pending.forEach((r) => {
      const p = productMap[String(r.product)];
      r.productGone = !p;
      r.productBusy = !!(p && p.assignedTo);
      r.productBlocked = !!(p && (p.condition === 'retired' || p.status === 'maintenance' || p.condition === 'needs-repair'));
    });

    // Bookings: what needs a decision, and what is coming up
    const pendingBookings = await Booking.find({ status: 'pending' })
      .sort({ bookedFor: 1, createdAt: 1 })
      .lean();
    const upcomingBookings = await Booking.find({
      status: 'confirmed',
      bookedFor: { $gte: todayKey() },
    })
      .sort({ bookedFor: 1 })
      .lean();

    // Flag pending bookings whose day is already confirmed for someone else
    const takenDays = new Set(upcomingBookings.map((b) => `${b.product}|${b.bookedFor}`));
    pendingBookings.forEach((b) => {
      b.dayTaken = takenDays.has(`${b.product}|${b.bookedFor}`);
      b.dayPassed = b.bookedFor < todayKey();
    });

    // Who is queueing behind whom right now (informational — holders decide)
    const waitingClaims = await NextClaim.find({ status: 'waiting' })
      .sort({ createdAt: 1 })
      .lean();

    res.render('requests/index', {
      title: 'Requests',
      active: 'requests',
      pending,
      decided,
      pendingBookings,
      upcomingBookings,
      waitingClaims,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// The signed-in admin's identity, for the audit trail
const whoIs = (req) => (req.admin && (req.admin.email || req.admin.name)) || 'admin';

// POST /admin/requests/:id/approve
exports.approve = async (req, res, next) => {
  try {
    const result = await approvals.approveRequest(req.params.id, whoIs(req));
    res.redirect(`/admin/requests?message=${encodeURIComponent(result.message)}`);
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/:id/reject
exports.reject = async (req, res, next) => {
  try {
    const result = await approvals.rejectRequest(req.params.id, whoIs(req), req.body.note);
    res.redirect(`/admin/requests?message=${encodeURIComponent(result.message)}`);
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/approve
exports.approveBooking = async (req, res, next) => {
  try {
    const result = await approvals.approveBooking(req.params.id, whoIs(req));
    res.redirect(`/admin/requests?message=${encodeURIComponent(result.message)}`);
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/reject
exports.rejectBooking = async (req, res, next) => {
  try {
    const result = await approvals.rejectBooking(req.params.id, whoIs(req), req.body.note);
    res.redirect(`/admin/requests?message=${encodeURIComponent(result.message)}`);
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/cancel — admin withdrawing a confirmed booking
exports.cancelBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, status: 'confirmed' });
    if (!booking) return res.redirect('/admin/requests?message=That booking is not active');

    booking.status = 'cancelled';
    booking.decidedAt = new Date();
    booking.decisionNote = 'Cancelled by the admin';
    booking.decidedBy = whoIs(req);
    await booking.save();

    const user = await User.findById(booking.user);
    if (user && user.telegramChatId) {
      notifyUser(
        user.telegramChatId,
        `\u26a0\ufe0f Your confirmed booking for <b>${escapeHtml(booking.productName)}</b> on <b>${escapeHtml(formatDay(booking.bookedFor))}</b> was cancelled by the admin.`
      );
    }

    res.redirect('/admin/requests?message=Booking cancelled');
  } catch (err) {
    next(err);
  }
};
