const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

/**
 * Admin sessions and the permission model built on top of them.
 *
 * The JWT carries the role and, for everyone below super, the studio they
 * are locked to. But the token is not trusted on its own for anything that
 * matters: on every request a real database account is re-read, so
 * deactivating an admin or moving them to another studio takes effect on
 * their very next click rather than whenever their token happens to expire.
 *
 * The root admin from `.env` is the exception — it has no database row, so
 * it is rebuilt from the environment each time.
 */

const ROOT_ID = 'root';

const readToken = (req) => {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.split(' ')[1];
  return null;
};

const isApiRequest = (req) => req.originalUrl.startsWith('/api');

const deny = (req, res, message) => {
  if (isApiRequest(req)) {
    return res.status(403).json({ success: false, message });
  }
  return res.status(403).render('error', {
    title: 'Not allowed',
    layout: 'auth-layout',
    code: 403,
    message,
  });
};

/**
 * Turn a decoded token into a live identity, re-reading the database so a
 * revoked or moved admin cannot keep working from an old token.
 * Returns null when the account is gone or deactivated.
 */
async function hydrate(decoded) {
  if (!decoded || decoded.role !== 'admin') return null;

  // The root admin from .env — always a super admin, never in the database
  if (decoded.id === ROOT_ID) {
    return {
      id: ROOT_ID,
      name: process.env.ADMIN_NAME || 'Studio Admin',
      email: String(process.env.ADMIN_EMAIL || '').toLowerCase(),
      adminRole: 'super',
      isRoot: true,
      location: null,
    };
  }

  const admin = await Admin.findById(decoded.id).lean();
  if (!admin || admin.status !== 'active') return null;

  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    adminRole: admin.role,
    isRoot: false,
    location: admin.location ? String(admin.location) : null,
  };
}

/**
 * Blocks anything that is not a signed-in, active admin, and decorates the
 * request with everything the views and controllers need to make decisions:
 *
 *   req.admin          the live identity
 *   req.can            a capability map, so views never test roles by hand
 *   req.scope          which studios this request may touch
 */
const protect = async (req, res, next) => {
  const token = readToken(req);

  if (!token) {
    if (isApiRequest(req)) return res.status(401).json({ success: false, message: 'No token provided' });
    return res.redirect('/login?error=Please sign in to continue');
  }

  let identity = null;
  try {
    identity = await hydrate(jwt.verify(token, process.env.JWT_SECRET));
  } catch (err) {
    identity = null;
  }

  if (!identity) {
    res.clearCookie('token');
    if (isApiRequest(req)) {
      return res.status(401).json({ success: false, message: 'Session expired or account is no longer active' });
    }
    return res.redirect('/login?error=Session expired, sign in again');
  }

  req.admin = identity;
  req.can = capabilities(identity);
  res.locals.admin = identity;
  res.locals.can = req.can;

  return next();
};

/**
 * What this admin is allowed to do. Everything in the views reads from here
 * rather than comparing role strings, so a rule only ever changes in one
 * place.
 */
function capabilities(admin) {
  const isSuper = admin.adminRole === 'super';
  const isLocationAdmin = admin.adminRole === 'location_admin';
  const isManager = admin.adminRole === 'location_manager';

  return {
    isSuper,
    isLocationAdmin,
    isManager,

    // Only the super admin works across studios
    viewAllStudios: isSuper,
    switchStudio: isSuper,
    manageStudios: isSuper,

    // Super admins create location admins; location admins create managers.
    // A manager creates nobody.
    manageAdmins: isSuper || isLocationAdmin,

    // Deleting is a primary-admin action; managers can add and edit only
    deleteItems: isSuper || isLocationAdmin,
    deletePeople: isSuper || isLocationAdmin,
    managePeople: true,
    manageItems: true,

    /**
     * Staff purchase requests belong to the studio, not to head office.
     * The super admin is deliberately excluded — see ProcurementRequest.
     */
    viewProcurement: isLocationAdmin || isManager,
    decideProcurement: isLocationAdmin,

    viewReports: true,
    viewAllReports: isSuper,
  };
}

/* ---------------- role guards ---------------- */

// Super admin only: studios, cross-studio pages, the master dashboard
const requireSuper = (req, res, next) => {
  if (req.admin && req.admin.adminRole === 'super') return next();
  return deny(req, res, 'Only the super admin can open this page.');
};

/**
 * The mirror image of requireSuper, and the reason it exists: staff purchase
 * requests are the location admin's own business. A super admin landing here
 * is not an error to fix by widening the query — they are told plainly that
 * this part of the system is not theirs.
 */
const blockSuper = (req, res, next) => {
  if (!req.admin) return deny(req, res, 'Please sign in to continue.');
  if (req.admin.adminRole === 'super') {
    return deny(
      req,
      res,
      'Purchase requests are private to each studio. They are raised by that studio\'s staff and handled by that studio\'s own admin, so they are not visible from the super admin account.'
    );
  }
  return next();
};

// Primary admins only (super or location admin) — never a manager
const requirePrimaryAdmin = (req, res, next) => {
  if (req.admin && req.admin.adminRole !== 'location_manager') return next();
  return deny(req, res, 'This action is limited to the primary admin of the studio.');
};

// Anyone who may manage admin accounts at all
const requireAdminManager = (req, res, next) => {
  if (req.can && req.can.manageAdmins) return next();
  return deny(req, res, 'Only a primary admin can manage admin accounts.');
};

/**
 * Sends someone who is already signed in to the right home page:
 * a super admin picks a studio, everyone else goes to their own dashboard,
 * staff go to the portal.
 */
const redirectIfAuth = (req, res, next) => {
  const token = readToken(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role === 'admin') {
        return res.redirect(decoded.adminRole === 'super' ? '/admin/studios' : '/admin/dashboard');
      }
    } catch (err) {
      res.clearCookie('token');
    }
  }

  const staffToken = req.cookies && req.cookies.staffToken;
  if (staffToken) {
    try {
      const decoded = jwt.verify(staffToken, process.env.JWT_SECRET);
      if (decoded.role === 'staff') return res.redirect('/staff');
    } catch (err) {
      res.clearCookie('staffToken');
    }
  }

  return next();
};

module.exports = {
  protect,
  redirectIfAuth,
  requireSuper,
  blockSuper,
  requirePrimaryAdmin,
  requireAdminManager,
  capabilities,
  ROOT_ID,
};
