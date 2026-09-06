require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');

const connectDB = require('./config/db');
const Admin = require('./models/Admin');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const apiRoutes = require('./routes/apiRoutes');
const staffRoutes = require('./routes/staffRoutes');
const { startBot } = require('./bot');
const {
  formatWhen,
  formatTime,
  formatDuration,
  formatSince,
  formatDay,
  RANGE_PRESETS,
} = require('./utils/format');
const { icon } = require('./utils/icons');

const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Helpers every view can use
app.use((req, res, next) => {
  res.locals.admin = null;
  res.locals.can = {};
  res.locals.scope = null;
  res.locals.activeStudio = null;
  res.locals.studios = [];
  res.locals.active = '';
  res.locals.formatDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  res.locals.formatMoney = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  res.locals.formatWhen = formatWhen;
  res.locals.formatTime = formatTime;
  res.locals.formatDuration = formatDuration;
  res.locals.formatSince = formatSince;
  res.locals.formatDay = formatDay;
  // The shortcut buttons on the shared date range control
  res.locals.RANGE_PRESETS = RANGE_PRESETS;
  // Available to every view, layout and partial — see utils/icons.js
  res.locals.icon = icon;
  next();
});

/**
 * The public shelf, split by studio.
 *
 * Anyone can see what is on the shelf without signing in, but a visitor now
 * picks a studio first — a single merged list across three cities would tell
 * somebody at Patna nothing useful about what they can walk over and collect.
 */
const Location = require('./models/Location');
const Product = require('./models/Product');
const User = require('./models/User');
const { CATEGORIES } = require('./models/Product');

app.get('/', async (req, res, next) => {
  try {
    const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();

    const counts = await Product.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]);
    const countMap = counts.reduce((acc, c) => ({ ...acc, [String(c._id)]: c.total }), {});
    studios.forEach((s) => {
      s.itemCount = countMap[String(s._id)] || 0;
    });

    // One studio only: skip the picker, there is nothing to choose between
    if (studios.length === 1) return res.redirect(`/shelf/${studios[0]._id}`);

    res.render('public-picker', { layout: false, studios });
  } catch (err) {
    next(err);
  }
});

app.get('/shelf/:studioId', async (req, res, next) => {
  try {
    const studio = await Location.findOne({ _id: req.params.studioId, status: 'active' }).lean();
    if (!studio) return res.redirect('/');

    const { q, category, status } = req.query;

    // The listing honours the filters; the stat cards always show the whole
    // studio, so the wall screen keeps its true totals.
    const filter = { location: studio._id };
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

    const hasFilter = Boolean(q || category || status);
    const [products, allProducts] = await Promise.all([
      Product.find(filter).sort({ category: 1, name: 1 }).lean(),
      hasFilter ? Product.find({ location: studio._id }).lean() : null,
    ]);
    const statSource = allProducts || products;

    const holderIds = [
      ...new Set(products.filter((p) => p.assignedTo).map((p) => String(p.assignedTo))),
    ];
    const holders = holderIds.length ? await User.find({ _id: { $in: holderIds } }, 'name').lean() : [];
    const holderMap = holders.reduce((acc, h) => ({ ...acc, [String(h._id)]: h.name }), {});

    const isBlocked = (p) =>
      p.condition === 'retired' || p.status === 'maintenance' || p.condition === 'needs-repair';

    const counts = {
      total: statSource.length,
      available: statSource.filter((p) => !p.assignedTo && !isBlocked(p)).length,
      occupied: statSource.filter((p) => p.assignedTo).length,
      maintenance: statSource.filter((p) => !p.assignedTo && isBlocked(p) && p.condition !== 'retired').length,
    };

    const groups = [];
    const map = new Map();
    products.forEach((p) => {
      if (!map.has(p.category)) {
        const g = { category: p.category, items: [], available: 0 };
        map.set(p.category, g);
        groups.push(g);
      }
      const g = map.get(p.category);
      g.items.push(p);
      if (!p.assignedTo && !isBlocked(p)) g.available += 1;
    });

    res.render('public-catalog', {
      layout: false,
      studio,
      groups,
      holderMap,
      counts,
      categories: CATEGORIES,
      statuses: ['available', 'assigned', 'maintenance'],
      query: { q: q || '', category: category || '', status: status || '' },
    });
  } catch (err) {
    next(err);
  }
});

app.use('/', authRoutes);
app.use('/staff', staffRoutes);

/**
 * Sidebar badge counts, on admin pages only.
 *
 * These run after `protect` and `withScope` have attached the identity, so
 * they are scoped exactly like the pages themselves: a location admin's badge
 * counts their own studio, and the purchase-request badge is never even
 * calculated for a super admin, who cannot open that page.
 *
 * A failed count must never block a page, so both fall back to 0.
 */
const AssignmentRequest = require('./models/AssignmentRequest');
const Booking = require('./models/Booking');
const ProcurementRequest = require('./models/ProcurementRequest');
const UsageLog = require('./models/UsageLog');
const { protect } = require('./middleware/auth');
const { withScope } = require('./middleware/scope');

app.use('/admin', protect, withScope, async (req, res, next) => {
  try {
    const scoped = req.scope.filter({ status: 'pending' });
    const [requests, bookings, checkIns] = await Promise.all([
      AssignmentRequest.countDocuments(scoped),
      Booking.countDocuments(scoped),
      /**
       * Items handed back but not yet checked in count towards the badge
       * too. Such an item is off the shelf and cannot be taken by anybody,
       * so a check-in queue nobody notices is the one real cost of the
       * two-step return — the badge is where it gets noticed.
       */
      UsageLog.countDocuments(req.scope.filter({ returnedAt: { $ne: null }, acceptedAt: null })),
    ]);
    res.locals.pendingRequestCount = requests + bookings + checkIns;

    res.locals.pendingPurchaseCount = req.can.viewProcurement
      ? await ProcurementRequest.countDocuments(req.scope.filter({ status: 'pending' }))
      : 0;
  } catch (err) {
    res.locals.pendingRequestCount = 0;
    res.locals.pendingPurchaseCount = 0;
  }
  next();
});

app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

// 404
app.use((req, res) => {
  if (req.originalUrl.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'Route not found' });
  }
  res.status(404).render('error', {
    title: 'Page not found',
    layout: 'auth-layout',
    code: 404,
    message: 'That page does not exist.',
  });
});

// Errors
app.use((err, req, res, next) => {
  console.error(err);
  if (req.originalUrl.startsWith('/api')) {
    return res.status(500).json({ success: false, message: err.message });
  }
  res.status(500).render('error', {
    title: 'Something broke',
    layout: 'auth-layout',
    code: 500,
    message: err.message || 'Something went wrong on the server.',
  });
});

const { startBookingScheduler } = require('./services/bookingAutoAssign');

/**
 * Start the database FIRST, then everything that depends on it.
 *
 * Previously the connection was fired and forgotten, so the app announced
 * "running on http://localhost:3000" and started the Telegram bot while the
 * connection was still being attempted — and then exited a moment later when
 * it failed. The success line printed above the error made a plain DNS
 * problem look like a crash mid-flight.
 *
 * Now nothing starts until the database is actually up, so the log reads in
 * the order things really happened.
 */
(async () => {
  await connectDB();

  /**
   * Carry any account still on the retired `location_manager` role over to
   * `location_sub_admin`. Done before the first request is served, because a
   * missed account would not error — it would just silently lose access.
   */
  try {
    const moved = await Admin.migrateRoles();
    if (moved) console.log(`Renamed ${moved} location manager account(s) to location sub admin`);
  } catch (err) {
    console.error('Could not migrate admin roles:', err.message);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Studio Tracker running on http://localhost:${PORT}`));

  // The Telegram bot runs in the same process. No token in .env means no bot,
  // and the admin panel carries on as normal.
  startBot();

  // Hands confirmed bookings to their booker on the booked day
  startBookingScheduler();
})();

/**
 * If the database drops later (laptop sleeps, wifi changes), the driver
 * reconnects on its own. Log it rather than letting it pass silently, so a
 * burst of slow pages has a visible cause.
 */
const mongoose = require('mongoose');
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected — retrying…'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));
