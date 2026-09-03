const express = require('express');
const router = express.Router();

const staff = require('../controllers/staffController');
const { protectStaff } = require('../middleware/staffAuth');
const { unreadCount } = require('../services/notifications');

// The old staff sign-in page now lives at the single /login form
router.get('/login', (req, res) => {
  const error = req.query.error ? `&error=${encodeURIComponent(req.query.error)}` : '';
  res.redirect(`/login?role=staff${error}`);
});
router.post('/login', staff.login);
router.post('/logout', staff.logout);

router.use(protectStaff);

// Unread-update count for the sidebar badge on every staff page.
// A failed count must never block a page, so it falls back to 0.
router.use(async (req, res, next) => {
  res.locals.unreadAlertCount = await unreadCount(req.staff._id);
  next();
});

router.get('/', staff.portal);
router.get('/inventory', staff.inventory);

// "We don't have this — can we get one?"
router.get('/purchase-requests', staff.purchaseRequests);
router.post('/purchase-requests', staff.createPurchaseRequest);
router.post('/purchase-requests/:id/cancel', staff.cancelPurchaseRequest);

router.post('/occupy/:id', staff.occupy);
router.post('/return/:id', staff.returnItem);
router.post('/book/:id', staff.book);
router.post('/requests/:id/cancel', staff.cancelRequest);
router.post('/bookings/:id/cancel', staff.cancelBooking);
router.post('/claim/:id', staff.claim);
router.post('/claims/:id/cancel', staff.cancelClaim);
router.post('/claims/:id/release', staff.releaseClaim);
router.post('/claims/:id/keep', staff.keepClaim);
router.post('/notifications/:id/read', staff.dismissNotification);
router.post('/notifications/read-all', staff.dismissAllNotifications);

module.exports = router;
