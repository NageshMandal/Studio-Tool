const Product = require('../models/Product');
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const { syncAssignment, releaseProduct, occupyProduct } = require('../services/occupancy');
const { dayRange } = require('../utils/format');

const CATEGORIES = [
  'Camera',
  'Lens',
  'Lighting',
  'Audio',
  'Computer',
  'Accessory',
  'Furniture',
  'Other',
];
const CONDITIONS = ['new', 'good', 'needs-repair', 'retired'];
const STATUSES = ['available', 'assigned', 'maintenance'];

const cleanBody = (body) => ({
  name: body.name,
  category: body.category,
  brand: body.brand,
  model: body.model,
  serialNumber: body.serialNumber,
  quantity: Number(body.quantity) || 0,
  condition: body.condition,
  status: body.status,
  location: body.location,
  purchaseDate: body.purchaseDate || null,
  price: Number(body.price) || 0,
  imageUrl: body.imageUrl,
  notes: body.notes,
});

// GET /admin/dashboard
exports.dashboard = async (req, res, next) => {
  try {
    const { start, end } = dayRange();

    const [totalItems, totalUsers, assignedItems, repairItems, units, recent, outNow, takenToday, returnedToday, linkedUsers] =
      await Promise.all([
        Product.countDocuments(),
        User.countDocuments(),
        Product.countDocuments({ status: 'assigned' }),
        Product.countDocuments({ condition: 'needs-repair' }),
        Product.aggregate([
          { $group: { _id: null, units: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$price', '$quantity'] } } } },
        ]),
        Product.find().sort({ createdAt: -1 }).limit(5).populate('assignedTo', 'name'),
        Product.find({ assignedTo: { $ne: null } }).sort({ occupiedAt: 1 }).limit(8).populate('assignedTo', 'name'),
        UsageLog.countDocuments({ occupiedAt: { $gte: start, $lt: end } }),
        UsageLog.countDocuments({ returnedAt: { $gte: start, $lt: end } }),
        User.countDocuments({ telegramChatId: { $ne: null } }),
      ]);

    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      stats: {
        totalItems,
        totalUsers,
        assignedItems,
        repairItems,
        totalUnits: units[0] ? units[0].units : 0,
        totalValue: units[0] ? units[0].value : 0,
        takenToday,
        returnedToday,
        linkedUsers,
      },
      recent,
      outNow,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/products
exports.list = async (req, res, next) => {
  try {
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

    const products = await Product.find(filter)
      .sort({ createdAt: -1 })
      .populate('assignedTo', 'name email');

    res.render('products/index', {
      title: 'Instruments',
      active: 'products',
      products,
      categories: CATEGORIES,
      statuses: STATUSES,
      query: { q: q || '', category: category || '', status: status || '' },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/products/new
exports.newForm = async (req, res, next) => {
  try {
    const users = await User.find({ status: 'active' }).sort({ name: 1 });
    res.render('products/form', {
      title: 'Add instrument',
      active: 'products',
      product: {},
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      formAction: '/admin/products',
      isEdit: false,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/products
exports.create = async (req, res, next) => {
  try {
    const product = await Product.create(cleanBody(req.body));

    if (req.body.assignedTo) {
      const holder = await User.findById(req.body.assignedTo);
      if (holder) await occupyProduct({ product, user: holder, reason: req.body.reason, source: 'admin' });
    }
    res.redirect('/admin/products?message=Instrument added');
  } catch (err) {
    const users = await User.find({ status: 'active' }).sort({ name: 1 });
    res.status(400).render('products/form', {
      title: 'Add instrument',
      active: 'products',
      product: req.body,
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      formAction: '/admin/products',
      isEdit: false,
      error: err.message,
    });
  }
};

// GET /admin/products/:id/edit
exports.editForm = async (req, res, next) => {
  try {
    const [product, users] = await Promise.all([
      Product.findById(req.params.id),
      User.find({ status: 'active' }).sort({ name: 1 }),
    ]);
    if (!product) return res.redirect('/admin/products?message=Instrument not found');

    res.render('products/form', {
      title: `Edit ${product.name}`,
      active: 'products',
      product,
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
      formAction: `/admin/products/${product._id}?_method=PUT`,
      isEdit: true,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/products/:id
exports.update = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.redirect('/admin/products?message=Instrument not found');

    const previousAssignee = product.assignedTo;
    Object.assign(product, cleanBody(req.body));
    await product.save();

    // Handing an item to someone (or taking it back) from the admin form
    // writes the same usage-log entries the bot would write.
    const users = await User.find({ status: 'active' });
    await syncAssignment({
      product,
      previousAssignee,
      nextAssigneeId: req.body.assignedTo,
      users,
      reason: req.body.reason,
      source: 'admin',
    });

    res.redirect('/admin/products?message=Instrument updated');
  } catch (err) {
    const users = await User.find({ status: 'active' }).sort({ name: 1 });
    res.status(400).render('products/form', {
      title: 'Edit instrument',
      active: 'products',
      product: { ...req.body, _id: req.params.id },
      users,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      statuses: STATUSES,
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
    if (product && product.assignedTo) {
      await releaseProduct({ product, source: 'admin', note: 'Instrument removed from the register' });
    }
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/admin/products?message=Instrument removed');
  } catch (err) {
    next(err);
  }
};
