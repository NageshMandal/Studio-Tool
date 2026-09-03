const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const { withScope } = require('../middleware/scope');
const { apiLogin } = require('../controllers/authController');
const Product = require('../models/Product');
const User = require('../models/User');
const Location = require('../models/Location');

/**
 * A small JSON API over the same data, for scripts and integrations.
 *
 * It goes through exactly the same guards as the panel — `protect` then
 * `withScope` — so the studio rules cannot be sidestepped by talking to the
 * API instead of the pages. A location admin's token only ever reads and
 * writes their own studio; a super admin's sees everything, or one studio if
 * they pass ?studio=.
 *
 * Note what is deliberately absent: there is no purchase-request endpoint
 * here. Those are studio-private, and adding a JSON route for them would be
 * the easiest possible way to undo that.
 */

// POST /api/auth/login -> { token }
router.post('/auth/login', apiLogin);

router.use(protect, withScope);

router.get('/me', (req, res) =>
  res.json({
    success: true,
    admin: {
      name: req.admin.name,
      email: req.admin.email,
      role: req.admin.adminRole,
      studio: req.scope.active ? { id: req.scope.activeId, name: req.scope.active.name } : null,
    },
    can: req.can,
  })
);

router.get('/studios', async (req, res, next) => {
  try {
    // A location admin sees only their own studio here, not the company list
    const filter = req.can.isSuper ? { status: 'active' } : { _id: req.admin.location };
    const studios = await Location.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, count: studios.length, data: studios });
  } catch (err) {
    next(err);
  }
});

/**
 * The studio a write should land in. Never taken from the request body: a
 * posted `location` is ignored so an item cannot be filed into a studio the
 * caller is not signed in to.
 */
const writeStudio = (req) => req.scope.activeId;

const needStudio = (req, res) => {
  if (writeStudio(req)) return true;
  res.status(400).json({
    success: false,
    message: 'Pick a studio first — pass ?studio=<id> or open one in the panel',
  });
  return false;
};

/* ---------------- items ---------------- */

router.get('/products', async (req, res, next) => {
  try {
    const products = await Product.find(req.scope.filter())
      .populate('assignedTo', 'name email')
      .populate('location', 'name code')
      .lean();
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    next(err);
  }
});

router.post('/products', async (req, res) => {
  try {
    if (!needStudio(req, res)) return;
    const { location, assetTag, ...rest } = req.body;
    const product = await Product.create({ ...rest, location: writeStudio(req) });
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/products/:id', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .lean();
    if (!product || !req.scope.owns(product)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product || !req.scope.owns(product)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    // An item never moves studio through the API — that would silently
    // rewrite two studios' reports at once
    const { location, assetTag, ...rest } = req.body;
    Object.assign(product, rest);
    await product.save();
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    if (!req.can.deleteItems) {
      return res.status(403).json({ success: false, message: 'Only a primary admin can delete items' });
    }
    const product = await Product.findById(req.params.id);
    if (!product || !req.scope.owns(product)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    await Product.findByIdAndDelete(product._id);
    res.json({ success: true, message: 'Item removed' });
  } catch (err) {
    next(err);
  }
});

/* ---------------- staff ---------------- */

router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find(req.scope.filter()).populate('location', 'name code').lean();
    res.json({ success: true, count: users.length, data: users });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res) => {
  try {
    if (!needStudio(req, res)) return;
    const { location, ...rest } = req.body;
    const user = await User.create({ ...rest, location: writeStudio(req) });
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('+password');
    if (!user || !req.scope.owns(user)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    const { password, location, ...rest } = req.body;
    Object.assign(user, rest);
    if (password) user.password = password;
    await user.save();
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    if (!req.can.deletePeople) {
      return res.status(403).json({ success: false, message: 'Only a primary admin can remove people' });
    }
    const user = await User.findById(req.params.id);
    if (!user || !req.scope.owns(user)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    // Release anything they hold, so no item is left pointing at a ghost
    await Product.updateMany(
      { assignedTo: user._id },
      { $set: { assignedTo: null, occupiedAt: null, occupyReason: null, status: 'available' } }
    );
    await User.findByIdAndDelete(user._id);
    res.json({ success: true, message: 'Person removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
