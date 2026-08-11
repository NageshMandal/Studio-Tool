const User = require('../models/User');
const Product = require('../models/Product');
const { releaseProduct } = require('../services/occupancy');

const DEPARTMENTS = ['Studio', 'Editing', 'Design', 'Production', 'Admin', 'Other'];

// GET /admin/users
exports.list = async (req, res, next) => {
  try {
    const { q, department, status } = req.query;
    const filter = {};

    if (q) {
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') },
        { employeeId: new RegExp(q, 'i') },
      ];
    }
    if (department) filter.department = department;
    if (status) filter.status = status;

    const users = await User.find(filter).sort({ createdAt: -1 }).lean();

    // How many instruments each person is holding
    const counts = await Product.aggregate([
      { $match: { assignedTo: { $ne: null } } },
      { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
    ]);
    const countMap = counts.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {});
    users.forEach((u) => {
      u.itemsHeld = countMap[u._id] || 0;
    });

    res.render('users/index', {
      title: 'People',
      active: 'users',
      users,
      departments: DEPARTMENTS,
      query: { q: q || '', department: department || '', status: status || '' },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/new
exports.newForm = (req, res) => {
  res.render('users/form', {
    title: 'Add person',
    active: 'users',
    user: {},
    departments: DEPARTMENTS,
    formAction: '/admin/users',
    isEdit: false,
    error: null,
  });
};

// POST /admin/users
exports.create = async (req, res) => {
  try {
    const { name, email, password, employeeId, phone, department, designation, status } = req.body;
    await User.create({ name, email, password, employeeId, phone, department, designation, status });
    res.redirect('/admin/users?message=Person added');
  } catch (err) {
    const message =
      err.code === 11000 ? 'That email is already registered' : err.message;
    res.status(400).render('users/form', {
      title: 'Add person',
      active: 'users',
      user: req.body,
      departments: DEPARTMENTS,
      formAction: '/admin/users',
      isEdit: false,
      error: message,
    });
  }
};

// GET /admin/users/:id/edit
exports.editForm = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect('/admin/users?message=Person not found');

    res.render('users/form', {
      title: `Edit ${user.name}`,
      active: 'users',
      user,
      departments: DEPARTMENTS,
      formAction: `/admin/users/${user._id}?_method=PUT`,
      isEdit: true,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/users/:id
exports.update = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.redirect('/admin/users?message=Person not found');

    const { name, email, password, employeeId, phone, department, designation, status } = req.body;
    Object.assign(user, { name, email, employeeId, phone, department, designation, status });

    // Only touch the password when a new one was typed in
    if (password && password.trim()) user.password = password.trim();

    await user.save();
    res.redirect('/admin/users?message=Person updated');
  } catch (err) {
    const message = err.code === 11000 ? 'That email is already registered' : err.message;
    res.status(400).render('users/form', {
      title: 'Edit person',
      active: 'users',
      user: { ...req.body, _id: req.params.id },
      departments: DEPARTMENTS,
      formAction: `/admin/users/${req.params.id}?_method=PUT`,
      isEdit: true,
      error: message,
    });
  }
};

// PATCH /admin/users/:id/password
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.redirect('/admin/users?message=Password must be at least 6 characters');
    }
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.redirect('/admin/users?message=Person not found');

    user.password = password;
    await user.save();
    res.redirect('/admin/users?message=Password changed');
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/status
exports.toggleStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect('/admin/users?message=Person not found');

    user.status = user.status === 'active' ? 'inactive' : 'active';
    await user.save();
    res.redirect(`/admin/users?message=${user.name} is now ${user.status}`);
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/unlink-telegram
exports.unlinkTelegram = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect('/admin/users?message=Person not found');

    user.telegramChatId = null;
    user.telegramUsername = null;
    user.telegramLinkedAt = null;
    await user.save();
    res.redirect(`/admin/users?message=${user.name} will need to sign in to the bot again`);
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/users/:id
exports.remove = async (req, res, next) => {
  try {
    // Release anything this person was holding, closing their usage log entries
    const held = await Product.find({ assignedTo: req.params.id });
    for (const product of held) {
      await releaseProduct({ product, source: 'admin', note: 'Holder removed from the register' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.redirect('/admin/users?message=Person removed');
  } catch (err) {
    next(err);
  }
};
