const jwt = require('jsonwebtoken');

const signToken = () =>
  jwt.sign(
    {
      id: 'admin',
      role: 'admin',
      name: process.env.ADMIN_NAME || 'Admin',
      email: process.env.ADMIN_EMAIL,
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

const credentialsMatch = (email = '', password = '') =>
  email.trim().toLowerCase() === String(process.env.ADMIN_EMAIL).toLowerCase() &&
  password === process.env.ADMIN_PASSWORD;

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
exports.login = (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).render('login', {
      title: 'Sign in',
      layout: 'auth-layout',
      error: 'Enter both email and password',
      email: email || '',
    });
  }

  if (!credentialsMatch(email, password)) {
    return res.status(401).render('login', {
      title: 'Sign in',
      layout: 'auth-layout',
      error: 'That email and password combination is not recognised',
      email,
    });
  }

  res.cookie('token', signToken(), cookieOptions());
  res.redirect('/admin/dashboard');
};

// POST /api/auth/login  (returns a token)
exports.apiLogin = (req, res) => {
  const { email, password } = req.body;
  if (!credentialsMatch(email, password)) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
  const token = signToken();
  res.cookie('token', token, cookieOptions());
  res.json({
    success: true,
    token,
    admin: { name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL, role: 'admin' },
  });
};

// GET /logout
exports.logout = (req, res) => {
  res.clearCookie('token');
  res.redirect('/login?error=You have been signed out');
};
