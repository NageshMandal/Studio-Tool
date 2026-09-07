const mongoose = require('mongoose');
const AssignmentRequest = require('../models/AssignmentRequest');
const UsageLog = require('../models/UsageLog');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const Product = require('../models/Product');
const User = require('../models/User');
const approvals = require('../services/approvals');
const { acceptSubmission, declineSubmission } = require('../services/occupancy');
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
     * Submissions waiting on a decision. Oldest first, because each one is
     * still sitting with the person who asked to hand it back and still
     * counted as out — this queue going unwatched is the one real cost of
     * the two-step return, so it is put where the admin already looks.
     */
    const submitted = await UsageLog.find({
      ...scoped,
      submittedAt: { $ne: null },
      returnedAt: null,
    })
      .sort({ submittedAt: 1 })
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
 * Decides a set of requests, one at a time.
 *
 * Shared by the batch buttons and the tick-a-few-and-act bar, so a bulk
 * decision behaves identically however it was started. It is a loop over the
 * same per-item calls the individual buttons use, not a separate bulk path —
 * which matters, because an item somebody else has taken in the meantime
 * still has to fail on its own terms.
 *
 * Failures are named rather than counted. "3 approved, 2 failed" tells an
 * admin nothing they can act on; naming the two tells them exactly what to
 * go and look at.
 */
async function decideRequests(req, res, requests, action) {
  if (requests.length === 0) {
    return res.redirect(backTo('Those requests have already been dealt with'));
  }

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

  // How many people were affected, because a bulk decision across several
  // staff is a different thing from one person's basket
  const people = new Set(requests.map((r) => r.userName)).size;

  const verb = action === 'approve' ? 'approved' : 'declined';
  const parts = [];
  if (done.length) {
    parts.push(
      `${done.length} ${verb}` + (people > 1 ? ` across ${people} people` : '')
    );
  }
  if (failed.length) parts.push(`${failed.length} could not be: ${failed.join(', ')}`);

  return res.redirect(backTo(parts.join(' · ')));
}

/**
 * POST /admin/requests/batch/:batch/:action — decide one person's batch.
 */
exports.decideBatch = async (req, res, next) => {
  try {
    const action = req.params.action === 'approve' ? 'approve' : 'reject';
    const requests = await AssignmentRequest.find({
      ...req.scope.filter(),
      batch: req.params.batch,
      status: 'pending',
    }).lean();

    return decideRequests(req, res, requests, action);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /admin/requests/bulk — decide whatever the admin ticked.
 *
 * The selection is free-form: any requests on the page, from any number of
 * people and any number of batches. A morning's queue is usually decided in
 * one sweep rather than one person at a time, and making that take twenty
 * clicks was the thing worth fixing.
 *
 * The ids are re-read from the database under the studio scope rather than
 * trusted from the form, so a request from another studio cannot be decided
 * by pasting its id into the page.
 */
exports.decideMany = async (req, res, next) => {
  try {
    const action = req.body.action === 'approve' ? 'approve' : 'reject';

    const ids = []
      .concat(req.body.ids || [])
      .map((id) => String(id))
      .filter((id) => mongoose.isValidObjectId(id));

    if (ids.length === 0) return res.redirect(backTo('Pick at least one request first'));

    const requests = await AssignmentRequest.find({
      ...req.scope.filter(),
      _id: { $in: ids },
      status: 'pending',
    }).lean();

    return decideRequests(req, res, requests, action);
  } catch (err) {
    return next(err);
  }
};

/**
 * Loads a submission and refuses it if it is not this studio's, or has
 * already been dealt with. Returns { log, product } or null after redirecting.
 */
async function loadSubmission(req, res) {
  const log = await UsageLog.findById(req.params.id);
  if (!log || !req.scope.owns(log)) {
    res.redirect(backTo('That submission belongs to another studio'));
    return null;
  }
  if (!log.submittedAt) {
    res.redirect(backTo('That item has not been submitted yet'));
    return null;
  }
  if (log.returnedAt) {
    res.redirect(backTo('That one has already been accepted'));
    return null;
  }

  const product = await Product.findById(log.product);
  if (!product) {
    res.redirect(backTo('That item no longer exists'));
    return null;
  }

  return { log, product };
}

/**
 * POST /admin/returns/:id/accept — accept a submission.
 *
 * This is the moment the item stops being the staff member's and goes back
 * into circulation. The admin's remark is required for the same reason the
 * staff member's is: a blank second opinion is not a second opinion.
 */
exports.acceptReturn = async (req, res, next) => {
  try {
    const remark = (req.body.remark || '').trim().slice(0, 300);
    if (remark.length < 2) {
      return res.redirect(backTo('Add a remark when you accept an item — type NA if it came back fine'));
    }

    const loaded = await loadSubmission(req, res);
    if (!loaded) return undefined;

    const condition = ['new', 'good', 'needs-repair', 'retired'].includes(req.body.condition)
      ? req.body.condition
      : null;

    await acceptSubmission({
      product: loaded.product,
      log: loaded.log,
      acceptedBy: whoIs(req),
      remark,
      condition,
    });

    return res.redirect(
      backTo(
        loaded.product.status === 'maintenance'
          ? `${loaded.product.name} accepted and sent to maintenance`
          : `${loaded.product.name} accepted and back on the shelf`
      )
    );
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /admin/returns/:id/decline — send a submission back.
 *
 * For when the item has not actually turned up, or something needs sorting
 * out first. It stays with the same person on the same loan, so nothing
 * about who is responsible changes — only the request is undone. Without
 * this, a submission made by mistake would sit in the queue forever, or an
 * admin would have to accept an item they never received.
 */
exports.declineReturn = async (req, res, next) => {
  try {
    const remark = (req.body.remark || '').trim().slice(0, 300);
    if (remark.length < 2) {
      return res.redirect(backTo('Say why you are sending it back, so they know what to do'));
    }

    const loaded = await loadSubmission(req, res);
    if (!loaded) return undefined;

    await declineSubmission({
      product: loaded.product,
      log: loaded.log,
      decidedBy: whoIs(req),
      remark,
    });

    const user = await User.findById(loaded.log.user);
    await pushNotification({
      user,
      kind: 'return-declined',
      title: 'Your submission was sent back',
      productName: loaded.log.productName,
      assetTag: loaded.log.assetTag,
      note: remark,
      telegramText:
        `\u21a9\ufe0f Your submission of <b>${escapeHtml(loaded.log.productName)}</b> ` +
        `<code>${escapeHtml(loaded.log.assetTag || '')}</code> was sent back by the admin.\n` +
        `\ud83d\udcdd ${escapeHtml(remark)}\n\nIt is still with you.`,
    });

    return res.redirect(backTo(`${loaded.product.name} sent back — it is still with ${loaded.log.userName}`));
  } catch (err) {
    return next(err);
  }
};

// POST /admin/requests/:id/approve// POST /admin/requests/:id/approve
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
