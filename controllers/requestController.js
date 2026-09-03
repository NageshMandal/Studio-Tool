const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const Product = require('../models/Product');
const User = require('../models/User');
const approvals = require('../services/approvals');
const { pushNotification } = require('../services/notifications');
const { escapeHtml, todayKey, formatDay } = require('../utils/format');

/**
 * The approval queue for one studio: people asking to take an item out now,
 * and people booking one for a future day.
 *
 * Both kinds are decided through the shared `approvals` service, so the panel
 * and the Telegram buttons can never drift apart. What is added here is the
 * studio check: an admin may only decide requests belonging to the studio
 * they are signed in to, whatever id arrives in the URL.
 */

const backTo = (message) => `/admin/requests?message=${encodeURIComponent(message)}`;

// The signed-in admin's identity, for the audit trail
const whoIs = (req) => (req.admin && (req.admin.email || req.admin.name)) || 'admin';

/**
 * Loads a request or booking and refuses it if it is not this studio's.
 * Returns the document, or null after redirecting.
 */
async function loadOwned(Model, req, res) {
  const doc = await Model.findById(req.params.id).lean();
  if (!doc) {
    res.redirect(backTo('That item is no longer in the queue'));
    return null;
  }
  if (!req.scope.owns(doc)) {
    res.redirect(backTo('That request belongs to another studio'));
    return null;
  }
  return doc;
}

// GET /admin/requests
exports.list = async (req, res, next) => {
  try {
    const scoped = req.scope.filter();

    const pending = await AssignmentRequest.find({ ...scoped, status: 'pending' })
      .sort({ createdAt: 1 }) // oldest first — first come, first served
      .lean();

    const decided = await AssignmentRequest.find({ ...scoped, status: { $ne: 'pending' } })
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
      r.productBlocked = !!(
        p &&
        (p.condition === 'retired' || p.status === 'maintenance' || p.condition === 'needs-repair')
      );
    });

    // Bookings: what needs a decision, and what is coming up
    const pendingBookings = await Booking.find({ ...scoped, status: 'pending' })
      .sort({ bookedFor: 1, createdAt: 1 })
      .lean();

    const upcomingBookings = await Booking.find({
      ...scoped,
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
    const waitingClaims = await NextClaim.find({ ...scoped, status: 'waiting' })
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

// POST /admin/requests/:id/approve
exports.approve = async (req, res, next) => {
  try {
    if (!(await loadOwned(AssignmentRequest, req, res))) return;
    const result = await approvals.approveRequest(req.params.id, whoIs(req), req.scope.activeId);
    res.redirect(backTo(result.message));
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/:id/reject
exports.reject = async (req, res, next) => {
  try {
    if (!(await loadOwned(AssignmentRequest, req, res))) return;
    const result = await approvals.rejectRequest(req.params.id, whoIs(req), req.body.note, req.scope.activeId);
    res.redirect(backTo(result.message));
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/approve
exports.approveBooking = async (req, res, next) => {
  try {
    if (!(await loadOwned(Booking, req, res))) return;
    const result = await approvals.approveBooking(req.params.id, whoIs(req), req.scope.activeId);
    res.redirect(backTo(result.message));
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/reject
exports.rejectBooking = async (req, res, next) => {
  try {
    if (!(await loadOwned(Booking, req, res))) return;
    const result = await approvals.rejectBooking(req.params.id, whoIs(req), req.body.note, req.scope.activeId);
    res.redirect(backTo(result.message));
  } catch (err) {
    next(err);
  }
};

// POST /admin/requests/bookings/:id/cancel — admin withdrawing a confirmed booking
exports.cancelBooking = async (req, res, next) => {
  try {
    if (!(await loadOwned(Booking, req, res))) return;

    const booking = await Booking.findOne({ _id: req.params.id, status: 'confirmed' });
    if (!booking) return res.redirect(backTo('That booking is not active'));

    booking.status = 'cancelled';
    booking.decidedAt = new Date();
    booking.decisionNote = 'Cancelled by the admin';
    booking.decidedBy = whoIs(req);
    await booking.save();

    const user = await User.findById(booking.user);
    await pushNotification({
      user,
      kind: 'booking-cancelled',
      title: 'Confirmed booking cancelled by the admin',
      productName: booking.productName,
      assetTag: booking.assetTag,
      bookedFor: booking.bookedFor,
      reason: booking.reason,
      note: booking.decisionNote,
      decidedBy: booking.decidedBy,
      refModel: 'Booking',
      refId: booking._id,
      telegramText:
        `\u26a0\ufe0f Your confirmed booking for <b>${escapeHtml(booking.productName)}</b> on ` +
        `<b>${escapeHtml(formatDay(booking.bookedFor))}</b> was cancelled by the admin.` +
        `\n\nIt is also waiting on your dashboard under <b>Updates from the admin</b>.`,
    });

    res.redirect(backTo('Booking cancelled'));
  } catch (err) {
    next(err);
  }
};
