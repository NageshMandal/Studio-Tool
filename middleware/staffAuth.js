const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Staff sessions for the web portal. Completely separate from the admin
 * cookie: staff sign in with the same email + password they use in the
 * Telegram bot, and get a 'staffToken' cookie that only opens /staff pages.
 */

const COOKIE = 'staffToken';

const readToken = (req) => (req.cookies && req.cookies[COOKIE]) || null;

// Blocks anything that is not a signed-in, active staff member
const protectStaff = async (req, res, next) => {
  const token = readToken(req);
  if (!token) return res.redirect('/login?error=Please sign in to continue');

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'staff') throw new Error('Not a staff token');

    const user = await User.findById(decoded.id);
    if (!user || user.status !== 'active') throw new Error('Account is not active');

    req.staff = user;
    res.locals.staff = user;
    return next();
  } catch (err) {
    res.clearCookie(COOKIE);
    return res.redirect('/login?error=Session expired, sign in again');
  }
};

// Sends an already signed-in staff member straight to the portal
const redirectIfStaff = (req, res, next) => {
  const token = readToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'staff') return res.redirect('/staff');
    return next();
  } catch (err) {
    res.clearCookie(COOKIE);
    return next();
  }
};

module.exports = { protectStaff, redirectIfStaff, STAFF_COOKIE: COOKIE };