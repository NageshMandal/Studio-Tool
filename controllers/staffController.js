const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const NextClaim = require('../models/NextClaim');
const { occupyProduct, releaseProduct } = require('../services/occupancy');
const { createBooking } = require('../services/booking');
const { createClaim, releaseForClaim, keepDespiteClaim } = require('../services/claims');
const { notifyAdmins } = require('../bot/notify');
const { escapeHtml, todayKey, formatDay } = require('../utils/format');
const { STAFF_COOKIE } = require('../middleware/staffAuth');
const { CATEGORIES, STATUSES } = require('./productController');

/**
 * The staff website: the same rules as the Telegram bot, in a browser.
 *
 * Staff sign in with the email + password from the People page. They can
 * view every tool, occupy (power accounts) or request (normal accounts),
 * return what they hold, and book an item for a future date.
 */

// Send the person back to the staff page they acted from (dashboard or
// inventory, keeping any filters), with a flash message.
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

// GET /staff/login
exports.loginForm = (req, res) => {
  res.render('staff/login', {
    title: 'Staff sign in',
    layout: 'auth-layout',
    error: req.query.error || null,
    email: '',
  });
};

// POST /staff/login
exports.login = async (req, res) => {
  const { email, password } = req.body;
  const fail = () =>
    res.status(401).render('staff/login', {
      title: 'Staff sign in',
      layout: 'auth-layout',
      error: 'Email or password did not match',
      email: email || '',
    });

  try {
    const user = await User.findOne({ email: (email || '').toLowerCase().trim() }).select('+password');
    if (!user || user.status !== 'active') return fail();
    if (!(await user.matchPassword(password || ''))) return fail();

    const token = jwt.sign({ id: user._id, role: 'staff' }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    res.cookie(STAFF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/staff');
  } catch (err) {
    fail();
  }
};

// POST /staff/logout
exports.logout = (req, res) => {
  res.clearCookie(STAFF_COOKIE);
  res.redirect('/login');
};

// GET /staff — staff dashboard: what I hold, my requests, claims and bookings
exports.portal = async (req, res, next) => {
  try {
    const user = req.staff;

    const myItems = await Product.find({ assignedTo: user._id })
      .sort({ occupiedAt: 1 })
      .lean();

    const myRequests = await AssignmentRequest.find({ user: user._id, status: 'pending' })
      .sort({ createdAt: -1 })
      .lean();

    const myBookings = await Booking.find({
      user: user._id,
      status: { $in: ['pending', 'confirmed'] },
      bookedFor: { $gte: todayKey() },
    })
      .sort({ bookedFor: 1 })
      .lean();

    // Bookings waiting for ME to submit an item I am holding
    const myItemIds = myItems.map((p) => p._id);
    const bookingsAwaitingMe = myItemIds.length
      ? await Booking.find({
          product: { $in: myItemIds },
          status: 'pending',
          awaitingReturn: true,
        }).sort({ bookedFor: 1 }).lean()
      : [];
    const awaitingByProduct = bookingsAwaitingMe.reduce((acc, b) => {
      const key = String(b.product);
      (acc[key] = acc[key] || []).push(b);
      return acc;
    }, {});

    // Next-in-line claims: someone waiting on an item I hold, plus my own claims
    const waitingClaims = await NextClaim.find({ status: 'waiting' }).lean();
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
      myItems,
      myRequests,
      myBookings,
      myClaims,
      awaitingByProduct,
      claimByProduct,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /staff/inventory — the full catalog with search and filters (same as admin)
exports.inventory = async (req, res, next) => {
  try {
    const user = req.staff;
    const { q, category, status } = req.query;

    const filter = {};
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
    const holderIds = [...new Set(products.filter((p) => p.assignedTo).map((p) => String(p.assignedTo)))];
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

    // Next-in-line claims: who is waiting on what
    const waitingClaims = await NextClaim.find({ status: 'waiting' }).lean();
    const claimByProduct = waitingClaims.reduce(
      (acc, c) => ({ ...acc, [String(c.product)]: c }),
      {}
    );

    // Today's confirmed bookings, so a reserved item says so
    const bookedToday = await Booking.find({ status: 'confirmed', bookedFor: todayKey() }).lean();
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

// POST /staff/occupy/:id — power occupies, normal files a request
exports.occupy = async (req, res, next) => {
  try {
    const user = req.staff;
    const reason = (req.body.reason || '').trim().slice(0, 120);
    if (reason.length < 2) return back(req, res, 'Please give a short reason first');

    const product = await Product.findById(req.params.id);
    if (!product) return back(req, res, 'That item no longer exists');

    if (user.accountType === 'power') {
      try {
        await occupyProduct({ product, user, reason, source: 'web' });
        return back(req, res, `${product.name} is now with you`);
      } catch (err) {
        return back(req, res, err.message);
      }
    }

    // Normal account: file a request for the admin
    if (product.assignedTo) return back(req, res, 'Someone just took it');
    if (product.condition === 'retired' || product.status === 'maintenance' || product.condition === 'needs-repair') {
      return back(req, res, 'This item is not available right now');
    }
    const duplicate = await AssignmentRequest.findOne({
      user: user._id,
      product: product._id,
      status: 'pending',
    });
    if (duplicate) return back(req, res, 'You have already asked for this one — waiting for the admin');

    const request = await AssignmentRequest.create({
      product: product._id,
      productName: product.name,
      assetTag: product.assetTag,
      imageUrl: product.imageUrl || null,
      user: user._id,
      userName: user.name,
      reason: reason || null,
    });

    notifyAdmins(
      `🙋 <b>${escapeHtml(request.userName)}</b> is asking for ` +
        `<b>${escapeHtml(request.productName)}</b> <code>${escapeHtml(request.assetTag || '')}</code> (from the website).\n` +
        (request.reason ? `📝 ${escapeHtml(request.reason)}\n` : '') +
        `Tap to decide, or use the panel → Requests.`,
      {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `aprq:${request._id}` },
            { text: '❌ Decline', callback_data: `rjrq:${request._id}` },
          ],
        ],
      }
    );

    back(req, res, 'Request sent to the admin — you will be notified on Telegram when it is decided');
  } catch (err) {
    next(err);
  }
};

// POST /staff/return/:id
exports.returnItem = async (req, res, next) => {
  try {
    const user = req.staff;
    const product = await Product.findById(req.params.id);
    if (!product) return back(req, res, 'That item no longer exists');
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
    const reason = (req.body.reason || '').trim().slice(0, 120);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return back(req, res, 'Pick a date for the booking');
    if (reason.length < 2) return back(req, res, 'Please give a short reason for the booking');

    const product = await Product.findById(req.params.id).lean();
    if (!product) return back(req, res, 'That item no longer exists');

    try {
      const booking = await createBooking({ product, user, dateKey, reason, source: 'web' });
      return back(
        res,
        booking.awaitingReturn
          ? `Booking filed for ${formatDay(dateKey)} — ${booking.holderNameAtCreation || 'the holder'} has been asked to submit the item; the admin will then confirm`
          : `Booking sent to the admin to confirm for ${formatDay(dateKey)} — you will be notified on Telegram`
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

    const product = await Product.findById(req.params.id).lean();
    if (!product) return back(req, res, 'That item no longer exists');

    try {
      const claim = await createClaim({ product, user, reason, source: 'web' });
      return back(
        res,
        `You are next in line for ${product.name} — ${claim.holderName || 'the holder'} has been asked to release it`
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