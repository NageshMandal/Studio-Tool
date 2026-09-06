const Product = require('../models/Product');
const User = require('../models/User');
const Location = require('../models/Location');
const AssignmentRequest = require('../models/AssignmentRequest');
const NextClaim = require('../models/NextClaim');
const { syncAssignment, releaseProduct, occupyProduct } = require('../services/occupancy');
const { CATEGORIES } = require('../models/Product');

/**
 * The item register, always seen through one studio.
 *
 * Every query here goes through `req.scope.filter()`, and every lookup by id
 * is re-checked with `req.scope.owns()`. That second check is the one that
 * matters: without it, an admin at Ranchi could edit a Patna camera simply by
 * pasting its id into the URL, and the filtered list page would never reveal
 * that they had.
 */

const CONDITIONS = ['new', 'good', 'needs-repair', 'retired'];
// 'pending-return' is set by the system, never chosen on the form, but it
// still has to be filterable — an admin needs to find what is waiting on them
const STATUSES = ['available', 'assigned', 'maintenance', 'pending-return'];

const cleanBody = (body) => ({
  name: body.name,
  category: body.category,
  brand: body.brand,
  model: body.model,
  serialNumber: body.serialNumber,
  condition: body.condition,
  status: body.status,
  storageArea: body.storageArea,
  purchaseDate: body.purchaseDate || null,
  price: Number(body.price) || 0,
  imageUrl: body.imageUrl,
  notes: body.notes,
});

const backTo = (message) => `/admin/products?message=${encodeURIComponent(message)}`;

// GET /admin/products
exports.list = async (req, res, next) => {
  try {
    const { q, category, status, condition } = req.query;

    const filter = req.scope.filter();
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
    if (condition) filter.condition = condition;

    const products = await Product.find(filter)
      .sort({ createdAt: -1 })
      .populate('assignedTo', 'name email')
      .populate('location', 'name code theme')
      .lean();

    res.render('products/index', {
      title: 'Items',
      active: 'products',
      products,
      categories: CATEGORIES,
      statuses: STATUSES,
      conditions: CONDITIONS,
      query: {
        q: q || '',
        category: category || '',
        status: status || '',
        condition: condition || '',
      },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/products/new
exports.newForm = async (req, res, next) => {
  try {
    const users = await User.find(req.scope.filter({ status: 'active' })).sort({ name: 1 }).lean();

    res.render('products/form', {
      title: 'Add item',
      active: 'products',
      product: {},
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      studio: req.scope.active,
      formAction: '/admin/products',
      isEdit: false,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/products
exports.create = async (req, res) => {
  try {
    // The studio is taken from the session, never from the form. A posted
    // location field is ignored, so an item cannot be filed into a studio
    // the person signed in to is not allowed to touch.
    const product = await Product.create({
      ...cleanBody(req.body),
      location: req.scope.activeId,
    });

    if (req.body.assignedTo) {
      const holder = await User.findOne(req.scope.filter({ _id: req.body.assignedTo }));
      if (holder) {
        await occupyProduct({ product, user: holder, reason: req.body.reason, source: 'admin' });
      }
    }

    res.redirect(backTo(`${product.name} added as ${product.assetTag}`));
  } catch (err) {
    const users = await User.find(req.scope.filter({ status: 'active' })).sort({ name: 1 }).lean();
    res.status(400).render('products/form', {
      title: 'Add item',
      active: 'products',
      product: req.body,
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      studio: req.scope.active,
      formAction: '/admin/products',
      isEdit: false,
      error: err.message,
    });
  }
};

// GET /admin/products/:id/edit
exports.editForm = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect(backTo('Item not found'));
    if (!req.scope.owns(product)) return res.redirect(backTo('That item belongs to another studio'));

    const users = await User.find(req.scope.filter({ status: 'active' })).sort({ name: 1 }).lean();

    res.render('products/form', {
      title: `Edit ${product.name}`,
      active: 'products',
      product,
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      studio: req.scope.active,
      formAction: `/admin/products/${product._id}?_method=PUT`,
      isEdit: true,
      error: req.query.error || null,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/products/:id
exports.update = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect(backTo('Item not found'));
    if (!req.scope.owns(product)) return res.redirect(backTo('That item belongs to another studio'));

    const previousAssignee = product.assignedTo;
    Object.assign(product, cleanBody(req.body));
    await product.save();

    // Handing an item over from the admin form writes the same usage-log
    // entries the bot would write, so the register never has gaps.
    const users = await User.find(req.scope.filter({ status: 'active' }));
    await syncAssignment({
      product,
      previousAssignee,
      nextAssigneeId: req.body.assignedTo,
      users,
      reason: req.body.reason,
      source: 'admin',
    });

    res.redirect(backTo(`${product.name} updated`));
  } catch (err) {
    const users = await User.find(req.scope.filter({ status: 'active' })).sort({ name: 1 }).lean();
    res.status(400).render('products/form', {
      title: 'Edit item',
      active: 'products',
      product: { ...req.body, _id: req.params.id },
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      studio: req.scope.active,
      formAction: `/admin/products/${req.params.id}?_method=PUT`,
      isEdit: true,
      error: err.message,
    });
  }
};

// DELETE /admin/products/:id
exports.remove = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect(backTo('Item not found'));
    if (!req.scope.owns(product)) return res.redirect(backTo('That item belongs to another studio'));

    if (product.assignedTo) {
      await releaseProduct({
        product,
        source: 'admin',
        note: 'Item removed from the register',
        acceptedBy: req.admin.email || req.admin.name,
        acceptRemark: 'Checked in automatically: the item was removed from the register',
      });
    }

    // Any open requests for it can no longer be honoured
    await AssignmentRequest.updateMany(
      { product: product._id, status: 'pending' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Item removed from the register' }
    );
    await NextClaim.updateMany(
      { product: product._id, status: 'waiting' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Item removed from the register' }
    );

    await Product.findByIdAndDelete(product._id);
    res.redirect(backTo(`${product.name} removed`));
  } catch (err) {
    next(err);
  }
};

// A wide range on a busy studio returns a lot of rows; the page is for
// reading, so it caps what it draws and says when it has
const TRACKER_ROW_LIMIT = 500;

/**
 * GET /admin/tracker — the "Studio Tracker" table from the design:
 * today's movements at this studio, in one place, with the status of each.
 */
exports.tracker = async (req, res, next) => {
  try {
    const UsageLog = require('../models/UsageLog');
    const { resolveRange, shiftRange, rangeQuery, todayKey } = require('../utils/format');

    const range = resolveRange(req.query, 'today');
    const { staff, status } = req.query;

    // Open at any point during the window, so a loan that spans the period
    // is counted rather than falling between two days
    const filter = req.scope.filter();
    if (range.end) filter.occupiedAt = { $lt: range.end };
    if (range.start) {
      filter.$or = [{ returnedAt: null }, { returnedAt: { $gte: range.start } }];
    }

    if (staff) filter.user = staff;
    if (status === 'out') filter.returnedAt = null;
    if (status === 'returned') filter.returnedAt = { $ne: null };

    const [rows, totalCount, staffList] = await Promise.all([
      UsageLog.find(filter).sort({ occupiedAt: -1 }).limit(TRACKER_ROW_LIMIT).lean(),
      UsageLog.countDocuments(filter),
      User.find(req.scope.filter({ status: 'active' }), 'name').sort({ name: 1 }).lean(),
    ]);

    const prev = shiftRange(range, -1);
    const next = shiftRange(range, 1);

    res.render('tracker', {
      title: 'Studio tracker',
      active: 'tracker',
      rows,
      staffList,
      range,
      prevUrl: prev ? `/admin/tracker${rangeQuery(req.query, prev)}` : null,
      nextUrl: next ? `/admin/tracker${rangeQuery(req.query, next)}` : null,
      maxDate: todayKey(),
      truncated: totalCount > rows.length,
      totalCount,
      rowLimit: TRACKER_ROW_LIMIT,
      query: { staff: staff || '', status: status || '' },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

exports.CATEGORIES = CATEGORIES;
exports.STATUSES = STATUSES;
exports.CONDITIONS = CONDITIONS;
