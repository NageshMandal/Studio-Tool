const ProcurementRequest = require('../models/ProcurementRequest');
const Product = require('../models/Product');
const User = require('../models/User');
const { CATEGORIES } = require('../models/Product');
const { pushNotification } = require('../services/notifications');
const { notifyLocationAdmins } = require('../bot/notify');
const { escapeHtml, searchRegex } = require('../utils/format');

/**
 * Staff purchase requests — "we don't have this, can we get one?"
 *
 * Reachable only by a location admin or manager. The route layer puts
 * `blockSuper` in front of everything here, so the super admin cannot open
 * these pages even by typing the URL; this controller therefore never has to
 * reason about them, and cannot leak them by forgetting a clause.
 *
 * Every query is still scoped with `req.scope.filter()` on top of that, so
 * one studio's admin cannot see another studio's requests either.
 */

const STATUSES = ProcurementRequest.STATUSES;
const STATUS_LABELS = ProcurementRequest.STATUS_LABELS;

const backTo = (message) => `/admin/purchase-requests?message=${encodeURIComponent(message)}`;

const whoIs = (req) => (req.admin && (req.admin.name || req.admin.email)) || 'admin';

// GET /admin/purchase-requests
exports.list = async (req, res, next) => {
  try {
    const { status, urgency, q } = req.query;

    const filter = req.scope.filter();
    if (status) filter.status = status;
    if (urgency) filter.urgency = urgency;
    const rx = searchRegex(q);
    if (rx) {
      filter.$or = [
        { itemName: rx },
        { reference: rx },
        { requesterName: rx },
      ];
    }

    const [requests, counts] = await Promise.all([
      ProcurementRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
      ProcurementRequest.aggregate([
        { $match: req.scope.filter() },
        { $group: { _id: '$status', total: { $sum: 1 } } },
      ]),
    ]);

    const countMap = counts.reduce((acc, c) => ({ ...acc, [c._id]: c.total }), {});

    res.render('procurement/index', {
      title: 'Purchase requests',
      active: 'purchase-requests',
      requests,
      counts: {
        pending: countMap.pending || 0,
        approved: countMap.approved || 0,
        ordered: countMap.ordered || 0,
        received: countMap.received || 0,
        rejected: countMap.rejected || 0,
        all: Object.values(countMap).reduce((a, b) => a + b, 0),
      },
      statuses: STATUSES,
      statusLabels: STATUS_LABELS,
      urgencies: ProcurementRequest.URGENCIES,
      query: { status: status || '', urgency: urgency || '', q: q || '' },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/purchase-requests/:id
exports.detail = async (req, res, next) => {
  try {
    const request = await ProcurementRequest.findById(req.params.id).lean();
    if (!request) return res.redirect(backTo('That request no longer exists'));
    if (!req.scope.owns(request)) {
      return res.redirect(backTo('That request belongs to another studio'));
    }

    const requester = await User.findById(request.requestedBy, 'name email phone department designation staffRole').lean();

    res.render('procurement/detail', {
      title: request.reference || 'Purchase request',
      active: 'purchase-requests',
      request,
      requester,
      statusLabels: STATUS_LABELS,
      categories: CATEGORIES,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/purchase-requests/:id/decide
 *
 * One endpoint for every move a request can make — approve, reject, mark
 * ordered, mark received. Keeping them together means the ownership check,
 * the notification and the audit fields are written the same way each time,
 * instead of drifting apart across four near-identical handlers.
 */
exports.decide = async (req, res, next) => {
  try {
    const { action, note, budget } = req.body;

    const request = await ProcurementRequest.findById(req.params.id);
    if (!request) return res.redirect(backTo('That request no longer exists'));
    if (!req.scope.owns(request)) {
      return res.redirect(backTo('That request belongs to another studio'));
    }

    // Only the primary location admin decides; a manager can read and chase,
    // but approving a purchase is a budget decision.
    if (!req.can.decideProcurement) {
      return res.redirect(backTo('Only the location admin can decide purchase requests'));
    }

    const now = new Date();
    const cleanNote = (note || '').trim().slice(0, 400) || null;
    let message;
    let notifyKind = 'purchase-update';
    let notifyTitle = '';
    let notifyText = '';

    switch (action) {
      case 'approve':
        if (request.status !== 'pending') {
          return res.redirect(backTo('That request has already been decided'));
        }
        request.status = 'approved';
        request.approvedBudget = budget ? Number(budget) : null;
        notifyKind = 'purchase-approved';
        notifyTitle = 'Purchase request approved';
        notifyText =
          `\u2705 Your request for <b>${escapeHtml(request.itemName)}</b> ` +
          `<code>${escapeHtml(request.reference)}</code> was <b>approved</b>.` +
          (cleanNote ? `\n\ud83d\udcdd ${escapeHtml(cleanNote)}` : '');
        message = `${request.reference} approved`;
        break;

      case 'reject':
        if (!['pending', 'approved'].includes(request.status)) {
          return res.redirect(backTo('That request can no longer be rejected'));
        }
        request.status = 'rejected';
        notifyKind = 'purchase-rejected';
        notifyTitle = 'Purchase request rejected';
        notifyText =
          `\u274c Your request for <b>${escapeHtml(request.itemName)}</b> ` +
          `<code>${escapeHtml(request.reference)}</code> was <b>not approved</b>.` +
          (cleanNote ? `\n\ud83d\udcdd ${escapeHtml(cleanNote)}` : '');
        message = `${request.reference} rejected`;
        break;

      case 'order':
        if (request.status !== 'approved') {
          return res.redirect(backTo('Approve the request before marking it ordered'));
        }
        request.status = 'ordered';
        request.orderedAt = now;
        notifyTitle = 'Purchase ordered';
        notifyText =
          `\ud83d\udce6 <b>${escapeHtml(request.itemName)}</b> ` +
          `<code>${escapeHtml(request.reference)}</code> has been <b>ordered</b>.` +
          (cleanNote ? `\n\ud83d\udcdd ${escapeHtml(cleanNote)}` : '');
        message = `${request.reference} marked as ordered`;
        break;

      case 'receive':
        if (!['approved', 'ordered'].includes(request.status)) {
          return res.redirect(backTo('That request is not waiting to be received'));
        }
        request.status = 'received';
        request.receivedAt = now;
        notifyTitle = 'Purchase received';
        notifyText =
          `\ud83c\udf89 <b>${escapeHtml(request.itemName)}</b> ` +
          `<code>${escapeHtml(request.reference)}</code> has arrived at the studio.` +
          (cleanNote ? `\n\ud83d\udcdd ${escapeHtml(cleanNote)}` : '');
        message = `${request.reference} marked as received — add it to the register when you are ready`;
        break;

      default:
        return res.redirect(backTo('Unknown action'));
    }

    request.decidedAt = now;
    request.decidedBy = whoIs(req);
    request.decisionNote = cleanNote;
    await request.save();

    // Tell the person who asked, on their dashboard and on Telegram
    const requester = await User.findById(request.requestedBy);
    await pushNotification({
      user: requester,
      kind: notifyKind,
      title: notifyTitle,
      productName: request.itemName,
      assetTag: request.reference,
      reason: request.reason,
      note: cleanNote,
      decidedBy: request.decidedBy,
      refModel: 'ProcurementRequest',
      refId: request._id,
      telegramText: `${notifyText}\n\nIt is also on your dashboard under <b>Updates from the admin</b>.`,
    });

    res.redirect(`/admin/purchase-requests/${request._id}?message=${encodeURIComponent(message)}`);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/purchase-requests/:id/add-to-register
 *
 * The last step: a received item becomes a real, taggable item in the
 * studio's register, carrying its own asset tag, and the request keeps a
 * link to it so the trail from "we need this" to "here it is on the shelf"
 * stays intact.
 */
exports.addToRegister = async (req, res, next) => {
  try {
    const request = await ProcurementRequest.findById(req.params.id);
    if (!request) return res.redirect(backTo('That request no longer exists'));
    if (!req.scope.owns(request)) {
      return res.redirect(backTo('That request belongs to another studio'));
    }
    if (request.status !== 'received') {
      return res.redirect(backTo('Mark the request as received first'));
    }
    if (request.linkedProduct) {
      return res.redirect(backTo('That item is already on the register'));
    }

    const product = await Product.create({
      name: request.itemName,
      location: request.location,
      category: CATEGORIES.includes(request.category) ? request.category : 'Other',
      condition: 'new',
      status: 'available',
      price: request.approvedBudget || request.estimatedPrice || 0,
      purchaseDate: request.receivedAt || new Date(),
      notes: `Added from purchase request ${request.reference}, raised by ${request.requesterName}.`,
      fromProcurement: request._id,
    });

    request.linkedProduct = product._id;
    await request.save();

    res.redirect(
      `/admin/products/${product._id}/edit?message=${encodeURIComponent(
        `${product.name} added to the register as ${product.assetTag} — fill in the rest of its details`
      )}`
    );
  } catch (err) {
    next(err);
  }
};

/* ---------------- the staff side ---------------- */

/**
 * Called from the staff portal. Kept here rather than in the staff
 * controller so the whole life of a purchase request — raised, decided,
 * received, shelved — reads top to bottom in one file.
 */
exports.createFromStaff = async (staffUser, body) => {
  const extraFields = [];

  // The form posts parallel arrays of labels and values for the free-form
  // rows, so a studio can capture whatever else it needs without a schema
  // change. Blank rows are dropped rather than stored as empty noise.
  const labels = [].concat(body.extraLabel || []);
  const values = [].concat(body.extraValue || []);
  labels.forEach((label, i) => {
    const cleanLabel = String(label || '').trim();
    const cleanValue = String(values[i] || '').trim();
    if (cleanLabel && cleanValue) {
      extraFields.push({ label: cleanLabel.slice(0, 60), value: cleanValue.slice(0, 300) });
    }
  });

  let purchaseUrl = String(body.purchaseUrl || '').trim() || null;
  if (purchaseUrl && !/^https?:\/\//i.test(purchaseUrl)) purchaseUrl = `https://${purchaseUrl}`;

  const request = await ProcurementRequest.create({
    location: staffUser.location,
    locationName: staffUser.locationName || null,
    itemName: String(body.itemName || '').trim(),
    category: String(body.category || 'Other').trim(),
    quantity: Math.max(1, Number(body.quantity) || 1),
    reason: String(body.reason || '').trim(),
    purchaseUrl,
    estimatedPrice: body.estimatedPrice ? Number(body.estimatedPrice) : null,
    urgency: ProcurementRequest.URGENCIES.includes(body.urgency) ? body.urgency : 'normal',
    neededBy: /^\d{4}-\d{2}-\d{2}$/.test(body.neededBy || '') ? body.neededBy : null,
    extraFields,
    requestedBy: staffUser._id,
    requesterName: staffUser.name,
    requesterRole: staffUser.staffRole,
    requesterDepartment: staffUser.department,
  });

  // Only the admins of THIS studio hear about it
  notifyLocationAdmins(
    staffUser.location,
    `\ud83d\uded2 <b>${escapeHtml(request.requesterName)}</b> is asking to buy ` +
      `<b>${escapeHtml(request.itemName)}</b> \u00d7${request.quantity} ` +
      `<code>${escapeHtml(request.reference)}</code>\n` +
      `\ud83d\udcdd ${escapeHtml(request.reason.slice(0, 200))}\n` +
      (request.purchaseUrl ? `\ud83d\udd17 ${escapeHtml(request.purchaseUrl)}\n` : '') +
      `\nOpen the panel \u2192 Purchase requests to decide.`
  );

  return request;
};
