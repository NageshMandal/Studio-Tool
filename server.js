require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');

const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const apiRoutes = require('./routes/apiRoutes');
const staffRoutes = require('./routes/staffRoutes');
const { startBot } = require('./bot');
const { formatWhen, formatTime, formatDuration, formatSince, formatDay, todayKey } = require('./utils/format');

const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

connectDB();

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

// Small helpers every view can use
app.use((req, res, next) => {
  res.locals.admin = null;
  res.locals.active = '';
  res.locals.formatDate = (d) =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  res.locals.formatMoney = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  res.locals.formatWhen = formatWhen;
  res.locals.formatTime = formatTime;
  res.locals.formatDuration = formatDuration;
  res.locals.formatSince = formatSince;
  res.locals.formatDay = formatDay;
  next();
});

// Public shelf view: anyone can see what is available and what is out,
// without signing in. Staff and admin sign-in links live in its header.
const Product = require('./models/Product');
const User = require('./models/User');
app.get('/', async (req, res, next) => {
  try {
    const products = await Product.find().sort({ category: 1, name: 1 }).lean();

    const holderIds = [...new Set(products.filter((p) => p.assignedTo).map((p) => String(p.assignedTo)))];
    const holders = holderIds.length ? await User.find({ _id: { $in: holderIds } }, 'name').lean() : [];
    const holderMap = holders.reduce((acc, h) => ({ ...acc, [String(h._id)]: h.name }), {});

    const isBlocked = (p) => p.condition === 'retired' || p.status === 'maintenance' || p.condition === 'needs-repair';
    const counts = {
      total: products.length,
      available: products.filter((p) => !p.assignedTo && !isBlocked(p)).length,
      occupied: products.filter((p) => p.assignedTo).length,
      maintenance: products.filter((p) => !p.assignedTo && isBlocked(p) && p.condition !== 'retired').length,
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

    res.render('public-catalog', { layout: false, groups, holderMap, counts });
  } catch (err) {
    next(err);
  }
});

app.use('/', authRoutes);
app.use('/staff', staffRoutes);

// Pending-request count for the sidebar badge, on admin pages only.
// A failed count must never block a page, so it falls back to 0.
const AssignmentRequest = require('./models/AssignmentRequest');
const Booking = require('./models/Booking');
app.use('/admin', async (req, res, next) => {
  try {
    const [requests, bookings] = await Promise.all([
      AssignmentRequest.countDocuments({ status: 'pending' }),
      Booking.countDocuments({ status: 'pending' }),
    ]);
    res.locals.pendingRequestCount = requests + bookings;
  } catch (err) {
    res.locals.pendingRequestCount = 0;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// The Telegram bot runs in the same process. No token in .env means no bot,
// and the admin panel carries on as normal.
startBot();

// Hands confirmed bookings to their booker on the booked day (runs a pass
// now, then every 5 minutes — picks up the date change automatically).
const { startBookingScheduler } = require('./services/bookingAutoAssign');
startBookingScheduler();