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
const { startBot } = require('./bot');
const { formatWhen, formatTime, formatDuration, formatSince } = require('./utils/format');

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
  next();
});

app.get('/', (req, res) => res.redirect('/admin/dashboard'));
app.use('/', authRoutes);
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
