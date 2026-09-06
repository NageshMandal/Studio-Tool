const AssignmentRequest = require('../models/AssignmentRequest');
const UsageLog = require('../models/UsageLog');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const Product = require('../models/Product');
const User = require('../models/User');
const approvals = require('../services/approvals');
const { acceptReturn: acceptReturnItem } = require('../services/occupancy');
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

    /**
     * Items handed back but not yet checked in. Oldest first, because an
     * item sitting here is off the shelf and unavailable to everyone — this
     * queue going unwatched is the one real cost of the two-step return, so
     * it is put where the admin already looks.
     */
    const submitted = await UsageLog.find({
      ...scoped,
      returnedAt: { $ne: null },
      acceptedAt: null,
    })
      .sort({ returnedAt: 1 })
      .lean();

    /**
     * Requests asked for together are shown together. A batch is only a
     * grouping for the screen — each row is still decided on its own, which
     * is what lets an admin approve three of five.
     */
    const batches = [];
    const loose = [];
    const byBatch = new Map();

    pending.forEach((r) => {
      if (!r.batch) return loose.push(r);
      if (!byBatch.has(r.batch)) {
        const group = { batch: r.batch, userName: r.userName, reason: r.reason, createdAt: r.createdAt, items: [] };
        byBatch.set(r.batch, group);
        batches.push(group);
      }
      byBatch.get(r.batch).items.push(r);
    });

    // A batch that has been whittled down to one is no longer a batch
    const realBatches = batches.filter((b) => b.items.length > 1);
    batches.filter((b) => b.items.length === 1).forEach((b) => loose.push(b.items[0]));
    loose.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    res.render('requests/index', {
      title: 'Requests',
      active: 'requests',
      pending,
      batches: realBatches,
      loose,
      submitted,
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

/**
 * POST /admin/requests/batch/:batch/:action — decide a whole batch at once.
 *
 * It is a loop over the same per-item calls the individual buttons use, not
 * a separate bulk path. That matters: an item that has since been taken by
 * somebody else still fails on its own terms, and the admin is told which
 * ones did rather than being shown one blanket success.
 */
exports.decideBatch = async (req, res, next) => {
  try {
    const action = req.params.action === 'approve' ? 'approve' : 'reject';
    const requests = await AssignmentRequest.find({
      ...req.scope.filter(),
      batch: req.params.batch,
      status: 'pending',
    }).lean();

    if (requests.length === 0) return res.redirect(backTo('Those requests have already been dealt with'));

    const done = [];
    const failed = [];

    for (const request of requests) {
      const result =
        action === 'approve'
          ? await approvals.approveRequest(request._id, whoIs(req), req.scope.activeId)
          : await approvals.rejectRequest(request._id, whoIs(req), req.body.note, req.scope.activeId);

      if (result.ok) done.push(request.productName);
      else failed.push(`${request.productName} (${result.message})`);
    }

    const verb = action === 'approve' ? 'approved' : 'declined';
    const parts = [];
    if (done.length) parts.push(`${done.length} ${verb}`);
    if (failed.length) parts.push(`${failed.length} could not be: ${failed.join(', ')}`);

    return res.redirect(backTo(parts.join(' · ')));
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /admin/returns/:id/accept — check in an item a staff member submitted.
 *
 * The admin's remark is required for the same reason the staff member's is:
 * a blank second opinion is not a second opinion. Only once this is done
 * does the item go back into circulation and whoever was waiting for it get
 * their turn.
 */
exports.acceptReturn = async (req, res, next) => {
  try {
    const remark = (req.body.remark || '').trim().slice(0, 300);
    if (remark.length < 2) {
      return res.redirect(backTo('Add a remark when you check an item in — type NA if it came back fine'));
    }

    const log = await UsageLog.findById(req.params.id);
    if (!log || !req.scope.owns(log)) {
      return res.redirect(backTo('That submission belongs to another studio'));
    }
    if (!log.returnedAt) return res.redirect(backTo('That item has not been submitted yet'));
    if (log.acceptedAt) return res.redirect(backTo('That one has already been checked in'));

    const product = await Product.findById(log.product);
    if (!product) return res.redirect(backTo('That item no longer exists'));

    const condition = ['new', 'good', 'needs-repair', 'retired'].includes(req.body.condition)
      ? req.body.condition
      : null;

    await acceptReturnItem({
      product,
      log,
      acceptedBy: whoIs(req),
      remark,
      condition,
    });

    return res.redirect(
      backTo(
        product.status === 'maintenance'
          ? `${product.name} checked in and sent to maintenance`
          : `${product.name} checked in and back on the shelf`
      )
    );
  } catch (err) {
    return next(err);
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
