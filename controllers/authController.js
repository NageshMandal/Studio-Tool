const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

/**
 * Two kinds of admin can sign in here:
 *  - the root admin from `.env` (ADMIN_EMAIL / ADMIN_PASSWORD), always there;
 *  - any active admin account created on the Admins page.
 * Both get the same role in the token and the same powers in the panel.
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

    const admin = await resolveAdmin(email, password);
    if (!admin) {
      return res.status(401).render('login', {
        title: 'Sign in',
        layout: 'auth-layout',
        error: 'That email and password combination is not recognised',
        email,
      });
    }

    res.cookie('token', signToken(admin), cookieOptions());
    res.redirect('/admin/dashboard');
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login  (returns a token)
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

// GET /logout
exports.logout = (req, res) => {
  res.clearCookie('token');
  res.redirect('/login?error=You have been signed out');
};
