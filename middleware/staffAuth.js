const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Staff sessions for the web portal. Completely separate from the admin
 * cookie: staff sign in with the same email and password they use in the
 * Telegram bot, and get a 'staffToken' cookie that only opens /staff pages.
 *
 * The studio is re-read from the database on every request rather than
 * trusted from the token, so moving somebody to another branch — or
 * archiving their branch — takes effect on their next click.
 */

const COOKIE = 'staffToken';

const readToken = (req) => (req.cookies && req.cookies[COOKIE]) || null;

// Blocks anything that is not a signed-in, active staff member at an active studio
const protectStaff = async (req, res, next) => {
  const token = readToken(req);
  if (!token) return res.redirect('/login?error=Please sign in to continue');

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'staff') throw new Error('Not a staff token');

    const user = await User.findById(decoded.id).populate('location', 'name code theme status');
    if (!user || user.status !== 'active') throw new Error('Account is not active');
    if (!user.location) throw new Error('No studio');
    if (user.location.status !== 'active') throw new Error('Studio archived');

    req.staff = user;
    // Everything this person can see is filtered by this id
    req.studioId = String(user.location._id);
    res.locals.staff = user;
    res.locals.studio = user.location;
    return next();
  } catch (err) {
    res.clearCookie(COOKIE);
    const reason =
      err.message === 'Studio archived'
        ? 'Your studio is no longer active. Contact your studio admin.'
        : err.message === 'No studio'
        ? 'Your account is not attached to a studio. Contact your studio admin.'
        : 'Session expired, sign in again';
    return res.redirect(`/login?error=${encodeURIComponent(reason)}`);
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
