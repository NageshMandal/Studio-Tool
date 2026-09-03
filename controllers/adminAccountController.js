const Admin = require('../models/Admin');
const Location = require('../models/Location');

/**
 * Admins managing admins — the place the hierarchy is actually enforced.
 *
 * Who can create whom:
 *
 *   super admin     → super admins, location admins, location managers,
 *                     at any studio.
 *   location admin  → location managers, AT THEIR OWN STUDIO ONLY.
 *   location manager→ nobody.
 *
 * Two rules protect the system from locking itself out:
 *   - nobody can deactivate or delete themselves;
 *   - the root `.env` admin has no database row, so it can never be touched
 *     from the panel at all. It is shown as a fixed row for clarity.
 *
 * Every lookup by id is re-checked against the caller's own scope, so an id
 * belonging to another studio, pasted into the URL, is refused rather than
 * acted on.
 */

const ROLE_LABELS = Admin.ROLE_LABELS;

/** Which roles this admin is allowed to hand out. */
function assignableRoles(admin) {
  if (admin.adminRole === 'super') return ['super', 'location_admin', 'location_manager'];
  if (admin.adminRole === 'location_admin') return ['location_manager'];
  return [];
}

/**
 * Can `me` act on the account `target`? A super admin can act on anyone but
 * themselves. A location admin can act only on managers at their own studio
 * — never on another location admin, and never on a super admin.
 */
function mayManage(me, target) {
  if (String(me.id) === String(target._id)) return false; // never yourself
  if (me.adminRole === 'super') return true;
  if (me.adminRole !== 'location_admin') return false;
  return (
    target.role === 'location_manager' &&
    String(target.location) === String(me.location)
  );
}

const backTo = (message) => `/admin/admins?message=${encodeURIComponent(message)}`;

// GET /admin/admins
exports.list = async (req, res, next) => {
  try {
    const me = req.admin;

    // A super admin sees every admin; anyone else sees only their own studio
    const filter = me.adminRole === 'super' ? {} : { location: me.location };

    const [admins, studios] = await Promise.all([
      Admin.find(filter).sort({ role: 1, createdAt: 1 }).populate('location', 'name code theme').lean(),
      Location.find({ status: 'active' }).sort({ name: 1 }).lean(),
    ]);

    admins.forEach((a) => {
      a.canManage = mayManage(me, a);
      a.isMe = String(me.id) === String(a._id);
      a.roleLabel = ROLE_LABELS[a.role];
    });

    res.render('admins/index', {
      title: 'Admin accounts',
      active: 'admins',
      admins,
      studios,
      roleLabels: ROLE_LABELS,
      canAdd: assignableRoles(me).length > 0,
      // The root admin is shown for completeness but is not editable here
      root: {
        name: process.env.ADMIN_NAME || 'Studio Admin',
        email: process.env.ADMIN_EMAIL,
        isMe: me.isRoot,
      },
      showRoot: me.adminRole === 'super',
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/admins/new
exports.newForm = async (req, res, next) => {
  try {
    const roles = assignableRoles(req.admin);
    if (!roles.length) return res.redirect(backTo('You cannot add admin accounts'));

    const studios =
      req.admin.adminRole === 'super'
        ? await Location.find({ status: 'active' }).sort({ name: 1 }).lean()
        : await Location.find({ _id: req.admin.location }).lean();

    res.render('admins/form', {
      title: 'Add admin',
      active: 'admins',
      account: {},
      roles,
      roleLabels: ROLE_LABELS,
      studios,
      lockedLocation: req.admin.adminRole !== 'super' ? req.admin.location : null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/admins
exports.create = async (req, res, next) => {
  const me = req.admin;
  const allowed = assignableRoles(me);

  const rerender = async (error, account) => {
    const studios =
      me.adminRole === 'super'
        ? await Location.find({ status: 'active' }).sort({ name: 1 }).lean()
        : await Location.find({ _id: me.location }).lean();
    res.status(400).render('admins/form', {
      title: 'Add admin',
      active: 'admins',
      account,
      roles: allowed,
      roleLabels: ROLE_LABELS,
      studios,
      lockedLocation: me.adminRole !== 'super' ? me.location : null,
      error,
    });
  };

  try {
    const { name, email, password, phone } = req.body;
    let { role, location } = req.body;

    if (!allowed.includes(role)) {
      return rerender('You cannot create an account with that role', req.body);
    }

    if (role === 'super') {
      location = null;
    } else {
      // A location admin may only ever create for their own studio, whatever
      // the form posted back
      if (me.adminRole !== 'super') location = me.location;
      if (!location) return rerender('Pick the studio this admin belongs to', req.body);

      const studio = await Location.findById(location).lean();
      if (!studio || studio.status !== 'active') {
        return rerender('That studio is not available', req.body);
      }

      /**
       * One primary admin per studio. A second location admin would leave
       * nobody clearly accountable for that studio's purchase decisions, so
       * the extra person is added as a manager instead.
       */
      if (role === 'location_admin') {
        const existing = await Admin.findOne({ location, role: 'location_admin' }).lean();
        if (existing) {
          return rerender(
            `${studio.name} already has a location admin (${existing.name}). Add this person as a location manager instead, or change the existing admin first.`,
            req.body
          );
        }
      }
    }

    const created = await Admin.create({
      name,
      email,
      password,
      phone,
      role,
      location,
      createdBy: me.email,
    });

    res.redirect(
      backTo(
        `${created.name} added as ${ROLE_LABELS[role]} — they can sign in with their email and password straight away`
      )
    );
  } catch (err) {
    const message = err.code === 11000 ? 'That email is already in use' : err.message;
    return rerender(message, req.body);
  }
};

// PATCH /admin/admins/:id/status
exports.toggleStatus = async (req, res, next) => {
  try {
    const target = await Admin.findById(req.params.id);
    if (!target) return res.redirect(backTo('Admin not found'));
    if (!mayManage(req.admin, target)) {
      return res.redirect(backTo('You cannot change that account'));
    }

    target.status = target.status === 'active' ? 'inactive' : 'active';
    // A deactivated admin should also stop hearing the bot
    if (target.status === 'inactive') {
      target.telegramChatId = null;
      target.telegramLinkedAt = null;
    }
    await target.save();

    res.redirect(backTo(`${target.name} is now ${target.status}`));
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/admins/:id/password
exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.redirect(backTo('Password must be at least 6 characters'));
    }

    const target = await Admin.findById(req.params.id).select('+password');
    if (!target) return res.redirect(backTo('Admin not found'));
    if (!mayManage(req.admin, target)) {
      return res.redirect(backTo('You cannot change that account'));
    }

    target.password = password;
    await target.save();
    res.redirect(backTo(`Password changed for ${target.name}`));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /admin/admins/:id/role — promote or demote, super admin only.
 * Kept separate from the edit form because changing what somebody can see
 * deserves its own deliberate action rather than being one field among many.
 */
exports.changeRole = async (req, res, next) => {
  try {
    if (req.admin.adminRole !== 'super') {
      return res.redirect(backTo('Only the super admin can change roles'));
    }

    const target = await Admin.findById(req.params.id);
    if (!target) return res.redirect(backTo('Admin not found'));
    if (String(req.admin.id) === String(target._id)) {
      return res.redirect(backTo('You cannot change your own role'));
    }

    const { role, location } = req.body;
    if (!Admin.ROLES.includes(role)) return res.redirect(backTo('Unknown role'));

    if (role === 'super') {
      target.role = 'super';
      target.location = null;
    } else {
      const studioId = location || target.location;
      if (!studioId) return res.redirect(backTo('Pick a studio for that role'));

      if (role === 'location_admin') {
        const existing = await Admin.findOne({
          location: studioId,
          role: 'location_admin',
          _id: { $ne: target._id },
        }).lean();
        if (existing) {
          return res.redirect(
            backTo(`That studio already has a location admin (${existing.name})`)
          );
        }
      }
      target.role = role;
      target.location = studioId;
    }

    await target.save();
    res.redirect(backTo(`${target.name} is now ${ROLE_LABELS[target.role]}`));
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/admins/:id
exports.remove = async (req, res, next) => {
  try {
    const target = await Admin.findById(req.params.id);
    if (!target) return res.redirect(backTo('Admin not found'));
    if (!mayManage(req.admin, target)) {
      return res.redirect(backTo('You cannot remove that account'));
    }

    await Admin.findByIdAndDelete(req.params.id);
    res.redirect(backTo(`${target.name} removed`));
  } catch (err) {
    next(err);
  }
};

exports.assignableRoles = assignableRoles;
exports.mayManage = mayManage;
