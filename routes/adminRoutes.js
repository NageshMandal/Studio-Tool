const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const products = require('../controllers/productController');
const users = require('../controllers/userController');
const logs = require('../controllers/logController');

// Everything below this line needs a valid admin JWT
router.use(protect);

router.get('/', (req, res) => res.redirect('/admin/dashboard'));
router.get('/dashboard', products.dashboard);

// Daily usage log
router.get('/logs', logs.daily);

// Instruments
router.get('/products', products.list);
router.get('/products/new', products.newForm);
router.post('/products', products.create);
router.get('/products/:id/edit', products.editForm);
router.put('/products/:id', products.update);
router.delete('/products/:id', products.remove);

// People
router.get('/users', users.list);
router.get('/users/new', users.newForm);
router.post('/users', users.create);
router.get('/users/:id/edit', users.editForm);
router.put('/users/:id', users.update);
router.patch('/users/:id/password', users.resetPassword);
router.patch('/users/:id/status', users.toggleStatus);
router.patch('/users/:id/unlink-telegram', users.unlinkTelegram);
router.delete('/users/:id', users.remove);

module.exports = router;
