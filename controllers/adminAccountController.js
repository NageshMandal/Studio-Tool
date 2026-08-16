const Admin = require('../models/Admin');

/**
 * Admins managing admins. Any signed-in admin can add another; nobody can
 * deactivate or delete themselves; the root `.env` admin is shown as a fixed
 * row and cannot be touched from here.
 */

const isSelf = (req, admin) => req.admin && String(req.admin.id) === String(admin._id);

// GET /admin/admins
exports.list = async (req, res, next) => {
  try {
    const admins = await Admin.find().sort({ createdAt: 1 }).lean();
    res.render('admins/index', {
      title: 'Admins',
      active: 'admins',
      admins,
      rootEmail: process.env.ADMIN_EMAIL,
      rootName: process.env.ADMIN_NAME || 'Root admin',
      me: req.admin,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/admins/new
exports.newForm = (req, res) => {
  res.render('admins/form', {
    title: 'Add admin',
    active: 'admins',
    admin: {},
    error: null,
  });
};

// POST /admin/admins
exports.create = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    await Admin.create({
      name,
      email,
      password,
      createdBy: (req.admin && req.admin.email) || null,
    });
    res.redirect('/admin/admins?message=Admin added — they can sign in to the panel and the Telegram bot straight away');
  } catch (err) {
    const message = err.code === 11000 ? 'That email is already an admin' : err.message;
    res.status(400).render('admins/form', {
      title: 'Add admin',
      active: 'admins',
      admin: req.body,
      error: message,
    });
  }
};

// PATCH /admin/admins/:id/status
exports.toggleStatus = async (req, res, next) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.redirect('/admin/admins?message=Admin not found');
    if (isSelf(req, admin)) return res.redirect('/admin/admins?message=You cannot deactivate yourself');

    admin.status = admin.status === 'active' ? 'inactive' : 'active';
    // A deactivated admin should also stop hearing the bot
    if (admin.status === 'inactive') {
      admin.telegramChatId = null;
      admin.telegramLinkedAt = null;
    }
    await admin.save();
    res.redirect(`/admin/admins?message=${admin.name} is now ${admin.status}`);
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/admins/:id/password
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.redirect('/admin/admins?message=Password must be at least 6 characters');
    }
    const admin = await Admin.findById(req.params.id).select('+password');
    if (!admin) return res.redirect('/admin/admins?message=Admin not found');

    admin.password = password;
    await admin.save();
    res.redirect('/admin/admins?message=Password changed');
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/admins/:id
exports.remove = async (req, res, next) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.redirect('/admin/admins?message=Admin not found');
    if (isSelf(req, admin)) return res.redirect('/admin/admins?message=You cannot remove yourself');

    await Admin.findByIdAndDelete(req.params.id);
    res.redirect('/admin/admins?message=Admin removed');
  } catch (err) {
    next(err);
  }
};
