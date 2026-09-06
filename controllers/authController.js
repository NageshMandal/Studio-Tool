const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Location = require('../models/Location');
const { STAFF_COOKIE } = require('../middleware/staffAuth');
const { ACTIVE_COOKIE, cookieOptions: scopeCookieOptions } = require('../middleware/scope');
const { ROOT_ID } = require('../middleware/auth');

/**
 * One sign-in form for everyone, at /login.
 *
 * The form carries a role selector, as in the design. It is a genuine
 * choice, not decoration: picking "Administrator" checks the credentials
 * against admin accounts only, and picking "Staff" checks them against
 * staff accounts only. That keeps the error message honest — someone typing
 * a staff password into the admin side is told the combination is not an
 * admin account, rather than being silently logged in somewhere unexpected.
 *
 * Leaving it on "Auto detect" tries admin first, then staff, which is what
 * most people want.
 *
 * Where they land afterwards depends on the role:
 *   super admin        → the studios page, to pick one
 *   location admin     → straight into their own studio's dashboard
 *   location sub admin → the same
 *   staff            → the staff portal
 */

const ROLE_CHOICES = [
  { value: '', label: 'Auto detect' },
  { value: 'admin', label: 'Administrator' },
  { value: 'staff', label: 'Staff member' },
];

const signAdminToken = (identity) =>
  jwt.sign(
    {
      id: identity.id,
      role: 'admin',
      adminRole: identity.adminRole,
      location: identity.location,
      name: identity.name,
      email: identity.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );

const adminCookieOptions = (remember) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge:
    (remember ? 30 : Number(process.env.COOKIE_EXPIRES_DAYS || 1)) * 24 * 60 * 60 * 1000,
});

const signStaffToken = (user) =>
  jwt.sign({ id: user._id, role: 'staff', location: String(user.location) }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

const staffCookieOptions = (remember) => ({
  httpOnly: true,
  sameSite: 'lax',
  maxAge: (remember ? 30 : 7) * 24 * 60 * 60 * 1000,
});

/**
 * Resolve the submitted credentials to an admin identity, or null.
 * The root admin from `.env` is checked first and is always a super admin.
 */
async function resolveAdmin(email = '', password = '') {
  const cleanEmail = String(email).trim().toLowerCase();

  if (
    cleanEmail === String(process.env.ADMIN_EMAIL || '').toLowerCase() &&
    password === process.env.ADMIN_PASSWORD
  ) {
    return {
      id: ROOT_ID,
      name: process.env.ADMIN_NAME || 'Studio Admin',
      email: String(process.env.ADMIN_EMAIL).toLowerCase(),
      adminRole: 'super',
      location: null,
      isRoot: true,
    };
  }

  const admin = await Admin.findOne({ email: cleanEmail, status: 'active' }).select('+password');
  if (!admin || !(await admin.matchPassword(password))) return null;

  // A location admin whose studio has been archived cannot sign in — there
  // is nothing for them to open, and a blank dashboard explains nothing.
  if (admin.role !== 'super') {
    const studio = await Location.findById(admin.location).lean();
    if (!studio || studio.status !== 'active') {
      return { blocked: 'Your studio is not active. Contact the super admin.' };
    }
  }

  admin.lastLoginAt = new Date();
  await admin.save({ validateBeforeSave: false });

  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    adminRole: admin.role,
    location: admin.location ? String(admin.location) : null,
    isRoot: false,
  };
}

/** Resolve the credentials to an active staff account, or null. */
async function resolveStaff(email = '', password = '') {
  const user = await User.findOne({ email: String(email).trim().toLowerCase() })
    .select('+password')
    .populate('location', 'name status');
  if (!user || user.status !== 'active') return null;
  if (!(await user.matchPassword(password || ''))) return null;
  if (!user.location || user.location.status !== 'active') {
    return { blocked: 'Your studio is not active. Contact your studio admin.' };
  }
  return user;
}

// Where an admin goes after signing in
const adminLanding = (identity) =>
  identity.adminRole === 'super' ? '/admin/studios' : '/admin/dashboard';

const renderLogin = (res, status, { error, email, role }) =>
  res.status(status).render('login', {
    title: 'Sign in',
    layout: 'auth-layout',
    error: error || null,
    email: email || '',
    role: role || '',
    roles: ROLE_CHOICES,
  });

// GET /login
exports.loginPage = (req, res) => {
  renderLogin(res, 200, { error: req.query.error, email: '', role: req.query.role });
};

// POST /login
exports.login = async (req, res, next) => {
  try {
    const { email, password, role } = req.body;
    const remember = Boolean(req.body.remember);

    if (!email || !password) {
      return renderLogin(res, 400, { error: 'Enter both email and password', email, role });
    }

    const wantsAdmin = role !== 'staff';
    const wantsStaff = role !== 'admin';

    if (wantsAdmin) {
      const admin = await resolveAdmin(email, password);
      if (admin && admin.blocked) {
        return renderLogin(res, 403, { error: admin.blocked, email, role });
      }
      if (admin) {
        res.cookie('token', signAdminToken(admin), adminCookieOptions(remember));
        // A fresh sign-in should never inherit the last session's studio
        res.clearCookie(ACTIVE_COOKIE);
        if (admin.adminRole !== 'super') {
          res.cookie(ACTIVE_COOKIE, admin.location, scopeCookieOptions());
        }
        return res.redirect(adminLanding(admin));
      }
    }

    if (wantsStaff) {
      const staff = await resolveStaff(email, password);
      if (staff && staff.blocked) {
        return renderLogin(res, 403, { error: staff.blocked, email, role });
      }
      if (staff) {
        res.cookie(STAFF_COOKIE, signStaffToken(staff), staffCookieOptions(remember));
        return res.redirect('/staff');
      }
    }

    const message =
      role === 'admin'
        ? 'That email and password is not an active administrator account'
        : role === 'staff'
        ? 'That email and password is not an active staff account'
        : 'That email and password combination is not recognised';

    return renderLogin(res, 401, { error: message, email, role });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login — returns a token (admins only)
exports.apiLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const admin = await resolveAdmin(email, password);
    if (!admin || admin.blocked) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = signAdminToken(admin);
    res.cookie('token', token, adminCookieOptions(false));
    res.json({
      success: true,
      token,
      admin: {
        name: admin.name,
        email: admin.email,
        role: admin.adminRole,
        location: admin.location,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /logout — clears every session, whichever one was in use
exports.logout = (req, res) => {
  res.clearCookie('token');
  res.clearCookie(STAFF_COOKIE);
  res.clearCookie(ACTIVE_COOKIE);
  res.redirect('/login?error=You have been signed out');
};

exports.ROLE_CHOICES = ROLE_CHOICES;
