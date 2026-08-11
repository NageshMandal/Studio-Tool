const jwt = require('jsonwebtoken');

const readToken = (req) => {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.split(' ')[1];
  return null;
};

// Blocks anything that is not a signed-in admin
const protect = (req, res, next) => {
  const token = readToken(req);
  const isApi = req.originalUrl.startsWith('/api');

  if (!token) {
    if (isApi) return res.status(401).json({ success: false, message: 'No token provided' });
    return res.redirect('/login?error=Please sign in to continue');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error('Not an admin token');
    req.admin = decoded;
    res.locals.admin = decoded;
    return next();
  } catch (err) {
    res.clearCookie('token');
    if (isApi) return res.status(401).json({ success: false, message: 'Session expired or token invalid' });
    return res.redirect('/login?error=Session expired, sign in again');
  }
};

// Sends an already signed-in admin straight to the dashboard
const redirectIfAuth = (req, res, next) => {
  const token = readToken(req);
  if (!token) return next();
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.redirect('/admin/dashboard');
  } catch (err) {
    res.clearCookie('token');
    return next();
  }
};

module.exports = { protect, redirectIfAuth };
