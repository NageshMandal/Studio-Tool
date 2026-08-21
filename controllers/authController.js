const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const User = require('../models/User');
const { STAFF_COOKIE } = require('../middleware/staffAuth');

/**
 * ONE sign-in form for everyone, at /login.
 *
 * The submitted email + password is tried against every kind of account,
 * in this order:
 *  1. the root admin from `.env` (ADMIN_EMAIL / ADMIN_PASSWORD);
 *  2. any active admin account created on the Admins page;
 *  3. any active staff account from the People page (same credentials as
 *     the Telegram bot).
 *
 * Admins land on /admin/dashboard, staff land on /staff. The two sessions
 * still use separate cookies, so the right pages stay protected.
 */

const signToken = (admin) =>
  jwt.sign(
    {
      id: admin.id,
      role: 'admin',
      name: admin.name,
      email: admin.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: Number(process.env.COOKIE_EXPIRES_DAYS || 1) * 24 * 60 * 60 * 1000,
});

const signStaffToken = (user) =>
  jwt.sign({ id: user._id, role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '7d' });

const staffCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

/**
 * Resolve the submitted credentials to an admin identity, or null.
 * Checks the `.env` root admin first, then the Admin collection.
 */
async function resolveAdmin(email = '', password = '') {
  const cleanEmail = String(email).trim().toLowerCase();

  if (
    cleanEmail === String(process.env.ADMIN_EMAIL).toLowerCase() &&
    password === process.env.ADMIN_PASSWORD
  ) {
    return { id: 'admin', name: process.env.ADMIN_NAME || 'Admin', email: process.env.ADMIN_EMAIL };
  }

  const admin = await Admin.findOne({ email: cleanEmail, status: 'active' }).select('+password');
  if (admin && (await admin.matchPassword(password))) {
    return { id: String(admin._id), name: admin.name, email: admin.email };
  }

  return null;
}

/** Resolve the credentials to an active staff account, or null. */
async function resolveStaff(email = '', password = '') {
  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select('+password');
  if (!user || user.status !== 'active') return null;
  if (!(await user.matchPassword(password || ''))) return null;
  return user;
}

// GET /login
exports.loginPage = (req, res) => {
  res.render('login', {
    title: 'Sign in',
    layout: 'auth-layout',
    error: req.query.error || null,
    email: '',
  });
};

// POST /login  (renders a page)
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).render('login', {
        title: 'Sign in',
        layout: 'auth-layout',
        error: 'Enter both email and password',
        email: email || '',
      });
    }

    // Admin accounts first…
    const admin = await resolveAdmin(email, password);
    if (admin) {
      res.cookie('token', signToken(admin), cookieOptions());
      return res.redirect('/admin/dashboard');
    }

    // …then staff accounts, with the same credentials as the Telegram bot
    const staff = await resolveStaff(email, password);
    if (staff) {
      res.cookie(STAFF_COOKIE, signStaffToken(staff), staffCookieOptions());
      return res.redirect('/staff');
    }

    return res.status(401).render('login', {
      title: 'Sign in',
      layout: 'auth-layout',
      error: 'That email and password combination is not recognised',
      email,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login  (returns a token — admin only, used by the API)
exports.apiLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const admin = await resolveAdmin(email, password);
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = signToken(admin);
    res.cookie('token', token, cookieOptions());
    res.json({
      success: true,
      token,
      admin: { name: admin.name, email: admin.email, role: 'admin' },
    });
  } catch (err) {
    next(err);
  }
};

// GET /logout — clears both sessions, whichever one was in use
exports.logout = (req, res) => {
  res.clearCookie('token');
  res.clearCookie(STAFF_COOKIE);
  res.redirect('/login?error=You have been signed out');
};