const express = require('express');
const router = express.Router();

const staff = require('../controllers/staffController');
const { protectStaff, redirectIfStaff } = require('../middleware/staffAuth');

router.get('/login', redirectIfStaff, staff.loginForm);
router.post('/login', staff.login);
router.post('/logout', staff.logout);

router.use(protectStaff);

router.get('/', staff.portal);
router.post('/occupy/:id', staff.occupy);
router.post('/return/:id', staff.returnItem);
router.post('/book/:id', staff.book);
router.post('/requests/:id/cancel', staff.cancelRequest);
router.post('/bookings/:id/cancel', staff.cancelBooking);
router.post('/claim/:id', staff.claim);
router.post('/claims/:id/cancel', staff.cancelClaim);
router.post('/claims/:id/release', staff.releaseClaim);
router.post('/claims/:id/keep', staff.keepClaim);

module.exports = router;
