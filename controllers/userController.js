const User = require('../models/User');
const Product = require('../models/Product');
const AssignmentRequest = require('../models/AssignmentRequest');
const NextClaim = require('../models/NextClaim');
const ProcurementRequest = require('../models/ProcurementRequest');
const { releaseProduct } = require('../services/occupancy');

/**
 * Staff, always seen through one studio.
 *
 * A person belongs to exactly one studio and is created into the studio the
 * admin is currently in — never into one chosen on the form. That is what
 * stops a location admin from quietly adding themselves a colleague at
 * another branch.
 */

const SUGGESTED_DEPARTMENTS = User.SUGGESTED_DEPARTMENTS;
const STAFF_ROLES = User.STAFF_ROLES;

/**
 * Departments to offer on the form and in the filter.
 *
 * The field is free text, so the useful list is whatever this studio is
 * actually using, with the built-in suggestions behind it for a studio that
 * has not typed anything of its own yet. Scoped to the current studio: Patna
 * should not be prompted with Kolkata's team names.
 */
async function departmentOptions(req) {
  const used = await User.distinct('department', req.scope.filter());
  const seen = new Map();
  [...used, ...SUGGESTED_DEPARTMENTS]
    .filter(Boolean)
    .forEach((d) => {
      // Keep the first spelling seen (the studio's own, since `used` is
      // first), so a suggestion cannot shadow what they actually typed
      const key = d.toLowerCase();
      if (!seen.has(key)) seen.set(key, d);
    });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Match a typed department against one already in use, ignoring case, and
 * reuse that exact spelling.
 *
 * Without this, "sales", "Sales" and "SALES" become three separate entries in
 * the filter dropdown and split the staff list three ways — the usual cost of
 * moving a field from a dropdown to free text.
 */
async function canonicalDepartment(req, typed) {
  const clean = String(typed || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Studio';

  const used = await User.distinct('department', req.scope.filter());
  const match = [...used, ...SUGGESTED_DEPARTMENTS]
    .filter(Boolean)
    .find((d) => d.toLowerCase() === clean.toLowerCase());

  return match || clean.slice(0, 60);
}

const backTo = (message) => `/admin/users?message=${encodeURIComponent(message)}`;

// GET /admin/users
exports.list = async (req, res, next) => {
  try {
    const { q, department, status, staffRole } = req.query;

    const filter = req.scope.filter();
    if (q) {
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') },
        { employeeId: new RegExp(q, 'i') },
      ];
    }
    if (department) filter.department = department;
    if (status) filter.status = status;
    if (staffRole) filter.staffRole = staffRole;

    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .populate('location', 'name code theme')
      .lean();

    // How many items each person is holding, and how many purchase requests
    // they have open — both useful before deactivating somebody
    const ids = users.map((u) => u._id);
    const [held, purchases] = await Promise.all([
      Product.aggregate([
        { $match: { assignedTo: { $in: ids } } },
        { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
      ]),
      ProcurementRequest.aggregate([
        { $match: { requestedBy: { $in: ids }, status: 'pending' } },
        { $group: { _id: '$requestedBy', count: { $sum: 1 } } },
      ]),
    ]);

    const heldMap = held.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {});
    const purchaseMap = purchases.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {});
    users.forEach((u) => {
      u.itemsHeld = heldMap[u._id] || 0;
      u.openPurchases = purchaseMap[u._id] || 0;
    });

    res.render('users/index', {
      title: 'Staff',
      active: 'users',
      users,
      departments: await departmentOptions(req),
      staffRoles: STAFF_ROLES,
      query: {
        q: q || '',
        department: department || '',
        status: status || '',
        staffRole: staffRole || '',
      },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/new
exports.newForm = async (req, res, next) => {
  try {
    res.render('users/form', {
      title: 'Add staff member',
      active: 'users',
      user: {},
      departments: await departmentOptions(req),
      staffRoles: STAFF_ROLES,
      studio: req.scope.active,
      formAction: '/admin/users',
      isEdit: false,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/users
exports.create = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      employeeId,
      phone,
      department,
      designation,
      status,
      accountType,
      staffRole,
    } = req.body;

    // Location comes from the session, not the form
    const created = await User.create({
      name,
      email,
      password,
      employeeId,
      phone,
      // Reuse an existing spelling when one matches, so the filter list
      // does not fill up with case variants of the same team
      department: await canonicalDepartment(req, department),
      designation,
      status,
      accountType,
      staffRole,
      location: req.scope.activeId,
    });

    res.redirect(backTo(`${created.name} added to ${req.scope.active.name}`));
  } catch (err) {
    const message = err.code === 11000 ? 'That email is already registered' : err.message;
    res.status(400).render('users/form', {
      title: 'Add staff member',
      active: 'users',
      user: req.body,
      departments: await departmentOptions(req),
      staffRoles: STAFF_ROLES,
      studio: req.scope.active,
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
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    res.render('users/form', {
      title: `Edit ${user.name}`,
      active: 'users',
      user,
      departments: await departmentOptions(req),
      staffRoles: STAFF_ROLES,
      studio: req.scope.active,
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
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    const {
      name,
      email,
      password,
      employeeId,
      phone,
      department,
      designation,
      status,
      accountType,
      staffRole,
    } = req.body;

    // `location` is intentionally absent: moving somebody between studios is
    // a super admin action, done from the transfer endpoint below.
    Object.assign(user, {
      name,
      email,
      employeeId,
      phone,
      department: await canonicalDepartment(req, department),
      designation,
      status,
      accountType,
      staffRole,
    });

    // Only touch the password when a new one was typed in
    if (password && password.trim()) user.password = password.trim();

    await user.save();
    res.redirect(backTo(`${user.name} updated`));
  } catch (err) {
    const message = err.code === 11000 ? 'That email is already registered' : err.message;
    res.status(400).render('users/form', {
      title: 'Edit staff member',
      active: 'users',
      user: { ...req.body, _id: req.params.id },
      departments: await departmentOptions(req),
      staffRoles: STAFF_ROLES,
      studio: req.scope.active,
      formAction: `/admin/users/${req.params.id}?_method=PUT`,
      isEdit: true,
      error: message,
    });
  }
};

/**
 * PATCH /admin/users/:id/transfer — move somebody to another studio.
 *
 * Super admin only, because it crosses a boundary nobody else can see across.
 * Anything they are holding is returned first: equipment does not travel with
 * the person, and leaving an open usage log pointing at a studio the holder
 * has left would quietly corrupt both studios' monthly reports.
 */
exports.transfer = async (req, res, next) => {
  try {
    if (!req.can.isSuper) return res.redirect(backTo('Only the super admin can move staff between studios'));

    const Location = require('../models/Location');
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect(backTo('Person not found'));

    const target = await Location.findById(req.body.location).lean();
    if (!target || target.status !== 'active') return res.redirect(backTo('Pick an active studio'));
    if (String(target._id) === String(user.location)) {
      return res.redirect(backTo(`${user.name} is already at ${target.name}`));
    }

    const held = await Product.find({ assignedTo: user._id });
    for (const product of held) {
      await releaseProduct({
        product,
        source: 'admin',
        note: `Holder transferred to ${target.name}`,
        claims: false,
        acceptedBy: req.admin.email || req.admin.name,
        acceptRemark: `Checked in automatically: holder transferred to ${target.name}`,
      });
    }

    await AssignmentRequest.updateMany(
      { user: user._id, status: 'pending' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Person transferred to another studio' }
    );
    await NextClaim.updateMany(
      { user: user._id, status: 'waiting' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Person transferred to another studio' }
    );

    user.location = target._id;
    await user.save();

    res.redirect(
      backTo(
        `${user.name} moved to ${target.name}${
          held.length ? ` — ${held.length} item${held.length === 1 ? '' : 's'} returned first` : ''
        }`
      )
    );
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/password
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.redirect(backTo('Password must be at least 6 characters'));
    }

    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    user.password = password;
    await user.save();
    res.redirect(backTo(`Password changed for ${user.name}`));
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/status
exports.toggleStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    user.status = user.status === 'active' ? 'inactive' : 'active';
    await user.save();
    res.redirect(backTo(`${user.name} is now ${user.status}`));
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/unlink-telegram
exports.unlinkTelegram = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    user.telegramChatId = null;
    user.telegramUsername = null;
    user.telegramLinkedAt = null;
    await user.save();
    res.redirect(backTo(`${user.name} will need to sign in to the bot again`));
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/users/:id
exports.remove = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.redirect(backTo('Person not found'));
    if (!req.scope.owns(user)) return res.redirect(backTo('That person belongs to another studio'));

    // Release anything they were holding, closing their usage log entries
    const held = await Product.find({ assignedTo: user._id });
    for (const product of held) {
      await releaseProduct({
        product,
        source: 'admin',
        note: 'Holder removed from the register',
        acceptedBy: req.admin.email || req.admin.name,
        acceptRemark: 'Checked in automatically: the holder was removed from the register',
      });
    }

    // Their open requests and claims no longer mean anything
    await AssignmentRequest.updateMany(
      { user: user._id, status: 'pending' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Person removed from the register' }
    );
    await NextClaim.updateMany(
      { user: user._id, status: 'waiting' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Claimant removed from the register' }
    );
    await ProcurementRequest.updateMany(
      { requestedBy: user._id, status: 'pending' },
      { status: 'cancelled', decidedAt: new Date(), decisionNote: 'Requester removed from the register' }
    );

    await User.findByIdAndDelete(user._id);
    res.redirect(backTo(`${user.name} removed`));
  } catch (err) {
    next(err);
  }
};

exports.SUGGESTED_DEPARTMENTS = SUGGESTED_DEPARTMENTS;
exports.departmentOptions = departmentOptions;
exports.canonicalDepartment = canonicalDepartment;
