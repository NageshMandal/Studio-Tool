const express = require('express');
const router = express.Router();

const {
  protect,
  requireSuper,
  blockSuper,
  requirePrimaryAdmin,
  requireAdminManager,
} = require('../middleware/auth');
const { withScope, requireStudio } = require('../middleware/scope');

const dashboard = require('../controllers/dashboardController');
const locations = require('../controllers/locationController');
const products = require('../controllers/productController');
const users = require('../controllers/userController');
const logs = require('../controllers/logController');
const requests = require('../controllers/requestController');
const procurement = require('../controllers/procurementController');
const reports = require('../controllers/reportController');
const adminAccounts = require('../controllers/adminAccountController');

/**
 * Admin routes and the guards on them.
 *
 * The order matters and is the same on every route:
 *   protect       — is this a live, active admin?
 *   withScope     — which studio are they looking at?
 *   requireStudio — does this page need one picked?
 *   role guard    — is this page theirs at all?
 *
 * Because `withScope` runs before every handler, no controller below has to
 * remember to filter by studio: it asks `req.scope.filter()` and gets the
 * right answer for whoever is signed in.
 */

router.use(protect);
router.use(withScope);

// Send everyone to the right home: a super admin picks a studio first
router.get('/', (req, res) =>
  res.redirect(req.can.isSuper && !req.scope.activeId ? '/admin/studios' : '/admin/dashboard')
);

/* ---------------- studios ---------------- */

/**
 * One screen for studios: picking, adding and editing all happen at
 * /admin/studios. It is open to any admin — a location admin simply sees
 * their own studio and no management controls, which keeps the header's
 * "switch studio" link honest. The three URLs below it are the old separate
 * pages, kept as redirects so existing links and bookmarks still land right.
 */
router.get('/studios', locations.hub);
router.get('/studios/open/:id', requireSuper, locations.open);
router.get('/studios/all', requireSuper, locations.openAll);

router.get('/studios/manage', requireSuper, locations.list);
router.get('/studios/new', requireSuper, locations.newForm);
router.post('/studios', requireSuper, locations.create);
router.get('/studios/:id/edit', requireSuper, locations.editForm);
router.put('/studios/:id', requireSuper, locations.update);
router.patch('/studios/:id/status', requireSuper, locations.toggleStatus);

/* ---------------- dashboards ---------------- */

// Every studio at once — the super admin's overview
router.get('/master', requireSuper, dashboard.master);

/**
 * The side panels behind the master dashboard's cards and lists. They return
 * HTML fragments, fetched by the page rather than linked to, so a drill-down
 * never costs the super admin the screen they were reading.
 */
router.get('/master/panel/:kind', requireSuper, dashboard.panel);

/**
 * Approving or declining from inside a panel. Super-admin only, and it
 * grants nothing new: a super admin can already decide these from inside a
 * studio. Purchase requests remain out of reach here as everywhere else.
 */
router.post('/master/decide', requireSuper, dashboard.decide);

// One studio
router.get('/dashboard', requireStudio, dashboard.dashboard);
router.get('/tracker', requireStudio, products.tracker);

/* ---------------- items ---------------- */

router.get('/products', requireStudio, products.list);
router.get('/products/new', requireStudio, products.newForm);
router.post('/products', requireStudio, products.create);
router.get('/products/:id/edit', requireStudio, products.editForm);
router.put('/products/:id', requireStudio, products.update);
// Deleting is a primary-admin action; a location sub admin can add and edit
router.delete('/products/:id', requireStudio, requirePrimaryAdmin, products.remove);

/* ---------------- staff ---------------- */

router.get('/users', requireStudio, users.list);
router.get('/users/new', requireStudio, users.newForm);
router.post('/users', requireStudio, users.create);
router.get('/users/:id/edit', requireStudio, users.editForm);
router.put('/users/:id', requireStudio, users.update);
router.patch('/users/:id/password', requireStudio, users.resetPassword);
router.patch('/users/:id/status', requireStudio, users.toggleStatus);
router.patch('/users/:id/unlink-telegram', requireStudio, users.unlinkTelegram);
// Moving somebody between studios crosses a boundary only a super admin sees
router.patch('/users/:id/transfer', requireSuper, users.transfer);
router.delete('/users/:id', requireStudio, requirePrimaryAdmin, users.remove);

/* ---------------- equipment requests and bookings ---------------- */

router.get('/requests', requireStudio, requests.list);

/**
 * Items handed back by staff, waiting for an admin to check them in. The
 * remark is what makes the record worth keeping, so it is required by the
 * handler rather than by the form alone.
 */
router.post('/returns/:id/accept', requireStudio, requests.acceptReturn);

// Several items asked for together, decided together. Declared before the
// :id routes so "batch" is never read as a request id.
router.post('/requests/batch/:batch/:action', requireStudio, requests.decideBatch);

router.post('/requests/:id/approve', requireStudio, requests.approve);
router.post('/requests/:id/reject', requireStudio, requests.reject);
router.post('/requests/bookings/:id/approve', requireStudio, requests.approveBooking);
router.post('/requests/bookings/:id/reject', requireStudio, requests.rejectBooking);
router.post('/requests/bookings/:id/cancel', requireStudio, requests.cancelBooking);

/* ---------------- purchase requests ---------------- *
 * Location-private. `blockSuper` is the whole point: these belong to the
 * studio that raised them, and the super admin is deliberately shut out
 * here rather than merely having them filtered away.
 */

router.use('/purchase-requests', requireStudio, blockSuper);
router.get('/purchase-requests', procurement.list);
router.get('/purchase-requests/:id', procurement.detail);
router.post('/purchase-requests/:id/decide', procurement.decide);
router.post('/purchase-requests/:id/add-to-register', procurement.addToRegister);

/* ---------------- reports ---------------- */

router.get('/reports/compare', requireSuper, reports.compare);
router.get('/reports/export.csv', reports.exportCsv);
router.get('/reports', reports.monthly);

/* ---------------- daily log ---------------- */

router.get('/logs', requireStudio, logs.daily);

/* ---------------- admin accounts ---------------- */

router.get('/admins', requireAdminManager, adminAccounts.list);
router.get('/admins/new', requireAdminManager, adminAccounts.newForm);
router.post('/admins', requireAdminManager, adminAccounts.create);
router.patch('/admins/:id/status', requireAdminManager, adminAccounts.toggleStatus);
router.patch('/admins/:id/password', requireAdminManager, adminAccounts.resetPassword);
router.patch('/admins/:id/role', requireSuper, adminAccounts.changeRole);
router.delete('/admins/:id', requireAdminManager, adminAccounts.remove);

/* ---------------- settings ---------------- */

router.get('/settings', (req, res) => {
  res.render('settings', {
    title: 'Settings',
    active: 'settings',
    studio: req.scope.active,
    message: req.query.message || null,
  });
});

module.exports = router;
