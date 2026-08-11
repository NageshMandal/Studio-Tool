const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const { apiLogin } = require('../controllers/authController');
const Product = require('../models/Product');
const User = require('../models/User');

// POST /api/auth/login -> { token }
router.post('/auth/login', apiLogin);

router.use(protect);

router.get('/me', (req, res) => res.json({ success: true, admin: req.admin }));

// Instruments
router.get('/products', async (req, res, next) => {
  try {
    const products = await Product.find().populate('assignedTo', 'name email');
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    next(err);
  }
});

router.post('/products', async (req, res, next) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/products/:id', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).populate('assignedTo', 'name email');
    if (!product) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Not found' });
    Object.assign(product, req.body);
    await product.save();
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Instrument removed' });
  } catch (err) {
    next(err);
  }
});

// People
router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find();
    res.json({ success: true, count: users.length, data: users });
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res) => {
  try {
    const user = await User.create(req.body);
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    const { password, ...rest } = req.body;
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
    await Product.updateMany({ assignedTo: req.params.id }, { $set: { assignedTo: null, status: 'available' } });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Person removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
