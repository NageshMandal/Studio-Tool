const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const ProcurementRequest = require('../models/ProcurementRequest');
const { occupyProduct, releaseProduct } = require('../services/occupancy');
const { createBooking } = require('../services/booking');
const { createClaim, releaseForClaim, keepDespiteClaim } = require('../services/claims');
const notifications = require('../services/notifications');
const procurement = require('./procurementController');
const { notifyLocationAdmins } = require('../bot/notify');
const { escapeHtml, todayKey, formatDay } = require('../utils/format');
const { STAFF_COOKIE } = require('../middleware/staffAuth');
const { CATEGORIES } = require('../models/Product');

/**
 * The staff website: the same rules as the Telegram bot, in a browser, and
 * everything filtered to the person's own studio.
 *
 * `req.studioId` is set by protectStaff from the live database record, so
 * every query below is scoped by something the person cannot influence.
 */

const STATUSES = ['available', 'assigned', 'maintenance'];

// Everything this person may see
const mine = (req, extra = {}) => ({ ...extra, location: req.studioId });

/**
 * Send the person back to the page they acted from (dashboard or inventory,
 * keeping any filters), with a flash message.
 */
const back = (req, res, message) => {
  let target = '/staff';
  try {
    const ref = req.get('referer');
    if (ref) {
      const u = new URL(ref, `http://${req.get('host') || 'localhost'}`);
      if (u.pathname.startsWith('/staff')) {
        u.searchParams.delete('message');
        u.searchParams.delete('error');
        const qs = u.searchParams.toString();
        target = u.pathname + (qs ? `?${qs}` : '');
      }
    }
  } catch (err) {
    /* fall back to /staff */
  }
  const sep = target.includes('?') ? '&' : '?';
  res.redirect(`${target}${sep}message=${encodeURIComponent(message)}`);
};

// POST /staff/login
exports.login = async (req, res) => {
  const { email, password } = req.body;
  const fail = (message) =>
    res.redirect(`/login?role=staff&error=${encodeURIComponent(message)}`);

  try {
    const user = await User.findOne({ email: (email || '').toLowerCase().trim() })
      .select('+password')
      .populate('location', 'status');
    if (!user || user.status !== 'active') return fail('Email or password did not match');
    if (!(await user.matchPassword(password || ''))) return fail('Email or password did not match');
    if (!user.location || user.location.status !== 'active') {
      return fail('Your studio is not active. Contact your studio admin.');
    }

    const token = jwt.sign(
      { id: user._id, role: 'staff', location: String(user.location._id) },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie(STAFF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/staff');
  } catch (err) {
    fail('Something went wrong signing in');
  }
};

// POST /staff/logout
exports.logout = (req, res) => {
  res.clearCookie(STAFF_COOKIE);
  res.redirect('/login');
};

// GET /staff — what I hold, my requests, claims, bookings and purchase asks
exports.portal = async (req, res, next) => {
  try {
    const user = req.staff;

    const { unread: alerts, recentlyRead: pastAlerts } = await notifications.listForStaff(user._id);

    const [myItems, myRequests, myBookings, myPurchases] = await Promise.all([
      Product.find(mine(req, { assignedTo: user._id })).sort({ occupiedAt: 1 }).lean(),

      AssignmentRequest.find({ user: user._id, status: 'pending' }).sort({ createdAt: -1 }).lean(),

      Booking.find({
        user: user._id,
        status: { $in: ['pending', 'confirmed'] },
        bookedFor: { $gte: todayKey() },
      })
        .sort({ bookedFor: 1 })
        .lean(),

      ProcurementRequest.find({ requestedBy: user._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    // Bookings waiting for ME to submit an item I am holding
    const myItemIds = myItems.map((p) => p._id);
    const bookingsAwaitingMe = myItemIds.length
      ? await Booking.find({
          product: { $in: myItemIds },
          status: 'pending',
          awaitingReturn: true,
        })
          .sort({ bookedFor: 1 })
          .lean()
      : [];
    const awaitingByProduct = bookingsAwaitingMe.reduce((acc, b) => {
      const key = String(b.product);
      (acc[key] = acc[key] || []).push(b);
      return acc;
    }, {});

    // Next-in-line claims at my studio, plus my own
    const waitingClaims = await NextClaim.find(mine(req, { status: 'waiting' })).lean();
    const claimByProduct = waitingClaims.reduce(
      (acc, c) => ({ ...acc, [String(c.product)]: c }),
      {}
    );
    const myClaims = waitingClaims.filter((c) => String(c.user) === String(user._id));

    res.render('staff/dashboard', {
      title: 'My dashboard',
      layout: 'staff/layout',
      active: 'staff-dashboard',
      user,
      alerts,
      pastAlerts,
      myItems,
      myRequests,
      myBookings,
      myClaims,
      myPurchases,
      awaitingByProduct,
      claimByProduct,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /staff/inventory — my studio's catalog, with search and filters
exports.inventory = async (req, res, next) => {
  try {
    const user = req.staff;
    const { q, category, status } = req.query;

    const filter = mine(req);
    if (q) {
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { assetTag: new RegExp(q, 'i') },
        { brand: new RegExp(q, 'i') },
        { serialNumber: new RegExp(q, 'i') },
      ];
    }
    if (category) filter.category = category;
    if (status) filter.status = status;

    const products = await Product.find(filter).sort({ category: 1, name: 1 }).lean();

    // Names of everyone holding something, for the status lines
    const holderIds = [
      ...new Set(products.filter((p) => p.assignedTo).map((p) => String(p.assignedTo))),
    ];
    const holders = holderIds.length
      ? await User.find({ _id: { $in: holderIds } }, 'name').lean()
      : [];
    const holderMap = holders.reduce((acc, h) => ({ ...acc, [String(h._id)]: h.name }), {});

    // My open requests by product, so the buttons match the bot's behaviour
    const myRequests = await AssignmentRequest.find({ user: user._id, status: 'pending' }).lean();
    const pendingByProduct = myRequests.reduce(
      (acc, r) => ({ ...acc, [String(r.product)]: r }),
      {}
    );

    const waitingClaims = await NextClaim.find(mine(req, { status: 'waiting' })).lean();
    const claimByProduct = waitingClaims.reduce(
      (acc, c) => ({ ...acc, [String(c.product)]: c }),
      {}
    );

    // Today's confirmed bookings, so a reserved item says so
    const bookedToday = await Booking.find(mine(req, { status: 'confirmed', bookedFor: todayKey() })).lean();
    const bookedTodayByProduct = bookedToday.reduce(
      (acc, b) => ({ ...acc, [String(b.product)]: b }),
      {}
    );

    // Group by category for the catalog
    const groups = [];
    const groupMap = new Map();
    products.forEach((p) => {
      if (!groupMap.has(p.category)) {
        const g = { category: p.category, items: [] };
        groupMap.set(p.category, g);
        groups.push(g);
      }
      groupMap.get(p.category).items.push(p);
    });

    res.render('staff/inventory', {
      title: 'Inventory',
      layout: 'staff/layout',
      active: 'staff-inventory',
      user,
      groups,
      holderMap,
      pendingByProduct,
      claimByProduct,
      bookedTodayByProduct,
      categories: CATEGORIES,
      statuses: STATUSES,
      query: { q: q || '', category: category || '', status: status || '' },
      todayKey: todayKey(),
      message: req.query.message || null,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
};

/* ---------------- purchase requests ---------------- */

// GET /staff/purchase-requests — my asks, and the form to raise a new one
exports.purchaseRequests = async (req, res, next) => {
  try {
    const requests = await ProcurementRequest.find({ requestedBy: req.staff._id })
      .sort({ createdAt: -1 })
      .lean();

    res.render('staff/purchase-requests', {
      title: 'Request an item',
      layout: 'staff/layout',
      active: 'staff-purchase',
      user: req.staff,
      requests,
      categories: CATEGORIES,
      urgencies: ProcurementRequest.URGENCIES,
      statusLabels: ProcurementRequest.STATUS_LABELS,
      today: todayKey(),
      message: req.query.message || null,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /staff/purchase-requests
 *
 * "We don't have this — can we get one?" The request is raised against the
 * person's own studio and goes to that studio's admins only.
 */
exports.createPurchaseRequest = async (req, res, next) => {
  try {
    const itemName = String(req.body.itemName || '').trim();
    const reason = String(req.body.reason || '').trim();

    if (itemName.length < 2) {
      return res.redirect('/staff/purchase-requests?error=Give the item a name');
    }
    if (reason.length < 10) {
      return res.redirect(
        '/staff/purchase-requests?error=Explain why it is needed — a sentence or two helps your admin decide'
      );
    }

    // One open ask per item per person, so a queue does not fill with
    // duplicates of the same lens
    const duplicate = await ProcurementRequest.findOne({
      requestedBy: req.staff._id,
      itemName: new RegExp(`^${itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      status: 'pending',
    }).lean();
    if (duplicate) {
      return res.redirect(
        `/staff/purchase-requests?error=${encodeURIComponent(
          `You already have an open request for ${itemName} (${duplicate.reference})`
        )}`
      );
    }

    const request = await procurement.createFromStaff(
      {
        _id: req.staff._id,
        name: req.staff.name,
        staffRole: req.staff.staffRole,
        department: req.staff.department,
        location: req.studioId,
        locationName: req.staff.location ? req.staff.location.name : null,
      },
      req.body
    );

    res.redirect(
      `/staff/purchase-requests?message=${encodeURIComponent(
        `Request ${request.reference} sent to your studio admin`
      )}`
    );
  } catch (err) {
    res.redirect(`/staff/purchase-requests?error=${encodeURIComponent(err.message)}`);
  }
};

// POST /staff/purchase-requests/:id/cancel
exports.cancelPurchaseRequest = async (req, res, next) => {
  try {
    const request = await ProcurementRequest.findOne({
      _id: req.params.id,
      requestedBy: req.staff._id,
      status: 'pending',
    });
    if (!request) {
      return res.redirect('/staff/purchase-requests?error=That request has already been decided');
    }

    request.status = 'cancelled';
    request.decidedAt = new Date();
    request.decisionNote = 'Withdrawn by the requester';
    await request.save();

    res.redirect(`/staff/purchase-requests?message=${encodeURIComponent(`${request.reference} withdrawn`)}`);
  } catch (err) {
    next(err);
  }
};

/* ---------------- equipment ---------------- */

// POST /staff/occupy/:id — power occupies, normal files a request
exports.occupy = async (req, res, next) => {
  try {
    const user = req.staff;
    const reason = (req.body.reason || '').trim().slice(0, 120);
    if (reason.length < 2) return back(req, res, 'Please give a short reason first');

    // Scoped lookup: an id from another studio simply is not found
    const product = await Product.findOne(mine(req, { _id: req.params.id }));
    if (!product) return back(req, res, 'That item is not at your studio');

    if (user.accountType === 'power') {
      try {
        await occupyProduct({ product, user, reason, source: 'web' });
        return back(req, res, `${product.name} is now with you`);
      } catch (err) {
        return back(req, res, err.message);
      }
    }

    // Normal account: file a request for the studio's admin
    if (product.assignedTo) return back(req, res, 'Someone just took it');
    if (
      product.condition === 'retired' ||
      product.status === 'maintenance' ||
      product.condition === 'needs-repair'
    ) {
      return back(req, res, 'This item is not available right now');
    }

    const duplicate = await AssignmentRequest.findOne({
      user: user._id,
      product: product._id,
      status: 'pending',
    });
    if (duplicate) return back(req, res, 'You have already asked for this one — waiting for the admin');

    const request = await AssignmentRequest.create({
      location: req.studioId,
      locationName: user.location ? user.location.name : null,
      product: product._id,
      productName: product.name,
      assetTag: product.assetTag,
      imageUrl: product.imageUrl || null,
      user: user._id,
      userName: user.name,
      reason: reason || null,
    });

    // Only the admins of this studio are told
    notifyLocationAdmins(
      req.studioId,
      `\ud83d\ude4b <b>${escapeHtml(request.userName)}</b> is asking for ` +
        `<b>${escapeHtml(request.productName)}</b> <code>${escapeHtml(request.assetTag || '')}</code> (from the website).\n` +
        (request.reason ? `\ud83d\udcdd ${escapeHtml(request.reason)}\n` : '') +
        `Tap to decide, or use the panel \u2192 Requests.`,
      {
        inline_keyboard: [
          [
            { text: '\u2705 Approve', callback_data: `aprq:${request._id}` },
            { text: '\u274c Decline', callback_data: `rjrq:${request._id}` },
          ],
        ],
      }
    );

    back(req, res, 'Request sent to your studio admin — you will be notified when it is decided');
  } catch (err) {
    next(err);
  }
};

// POST /staff/return/:id
exports.returnItem = async (req, res, next) => {
  try {
    const user = req.staff;
    const product = await Product.findOne(mine(req, { _id: req.params.id }));
    if (!product) return back(req, res, 'That item is not at your studio');
    if (!product.assignedTo || String(product.assignedTo) !== String(user._id)) {
      return back(req, res, 'That one is not with you');
    }
    await releaseProduct({ product, source: 'web' });
    back(req, res, `${product.name} is back on the shelf — thank you`);
  } catch (err) {
    next(err);
  }
};

// POST /staff/book/:id
exports.book = async (req, res, next) => {
  try {
    const user = req.staff;
    const dateKey = (req.body.date || '').trim();
    const pickupTime = (req.body.pickupTime || '').trim();
    const dropDate = (req.body.dropDate || '').trim();
    const dropTime = (req.body.dropTime || '').trim();
    const reason = (req.body.reason || '').trim().slice(0, 120);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return back(req, res, 'Pick a pickup date for the booking');
    if (!/^\d{2}:\d{2}$/.test(pickupTime)) return back(req, res, 'Pick a pickup time for the booking');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dropDate)) return back(req, res, 'Pick a drop date for the booking');
    if (!/^\d{2}:\d{2}$/.test(dropTime)) return back(req, res, 'Pick a drop time for the booking');
    if (reason.length < 2) return back(req, res, 'Please give a short reason for the booking');

    const product = await Product.findOne(mine(req, { _id: req.params.id })).lean();
    if (!product) return back(req, res, 'That item is not at your studio');

    try {
      const booking = await createBooking({
        product,
        user,
        dateKey,
        reason,
        pickupTime,
        dropDate,
        dropTime,
        source: 'web',
      });
      return back(
        req,
        res,
        booking.awaitingReturn
          ? `Booking filed for ${formatDay(dateKey)} — ${
              booking.holderNameAtCreation || 'the holder'
            } has been asked to submit the item; the admin will then confirm`
          : `Booking sent to your studio admin to confirm for ${formatDay(dateKey)}`
      );
    } catch (err) {
      return back(req, res, err.message);
    }
  } catch (err) {
    next(err);
  }
};

// POST /staff/requests/:id/cancel
exports.cancelRequest = async (req, res, next) => {
  try {
    const request = await AssignmentRequest.findOne({
      _id: req.params.id,
      user: req.staff._id,
      status: 'pending',
    });
    if (!request) return back(req, res, 'That request has already been dealt with');
    request.status = 'cancelled';
    request.decidedAt = new Date();
    await request.save();
    back(req, res, 'Request cancelled');
  } catch (err) {
    next(err);
  }
};

// POST /staff/bookings/:id/cancel
exports.cancelBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      user: req.staff._id,
      status: { $in: ['pending', 'confirmed'] },
    });
    if (!booking) return back(req, res, 'That booking has already been dealt with');
    booking.status = 'cancelled';
    booking.decidedAt = new Date();
    await booking.save();
    back(req, res, 'Booking cancelled');
  } catch (err) {
    next(err);
  }
};

// POST /staff/claim/:id — power user claims the next turn on an occupied item
exports.claim = async (req, res, next) => {
  try {
    const user = req.staff;
    const reason = (req.body.reason || '').trim().slice(0, 120);
    if (reason.length < 2) return back(req, res, 'Please give a short reason first');

    const product = await Product.findOne(mine(req, { _id: req.params.id })).lean();
    if (!product) return back(req, res, 'That item is not at your studio');

    try {
      const claim = await createClaim({ product, user, reason, source: 'web' });
      return back(
        req,
        res,
        `You are next in line for ${product.name} — ${
          claim.holderName || 'the holder'
        } has been asked to release it`
      );
    } catch (err) {
      return back(req, res, err.message);
    }
  } catch (err) {
    next(err);
  }
};

// POST /staff/claims/:id/cancel — claimant withdrawing
exports.cancelClaim = async (req, res, next) => {
  try {
    const claim = await NextClaim.findOne({
      _id: req.params.id,
      user: req.staff._id,
      status: 'waiting',
    });
    if (!claim) return back(req, res, 'That claim has already been dealt with');
    claim.status = 'cancelled';
    claim.decidedAt = new Date();
    await claim.save();
    back(req, res, 'Claim cancelled');
  } catch (err) {
    next(err);
  }
};

// POST /staff/claims/:id/release — the holder releases; the item hands over
exports.releaseClaim = async (req, res, next) => {
  try {
    const result = await releaseForClaim(req.params.id, req.staff);
    back(req, res, result.message);
  } catch (err) {
    next(err);
  }
};

// POST /staff/claims/:id/keep — the holder keeps it; the claimant is told
exports.keepClaim = async (req, res, next) => {
  try {
    const result = await keepDespiteClaim(req.params.id, req.staff);
    back(req, res, result.message);
  } catch (err) {
    next(err);
  }
};

// POST /staff/notifications/:id/read — dismiss one update
exports.dismissNotification = async (req, res, next) => {
  try {
    const done = await notifications.markRead(req.params.id, req.staff._id);
    back(req, res, done ? 'Update dismissed' : 'That update is already cleared');
  } catch (err) {
    next(err);
  }
};

// POST /staff/notifications/read-all — dismiss everything at once
exports.dismissAllNotifications = async (req, res, next) => {
  try {
    const count = await notifications.markAllRead(req.staff._id);
    back(req, res, count ? `Cleared ${count} update${count === 1 ? '' : 's'}` : 'Nothing to clear');
  } catch (err) {
    next(err);
  }
};
