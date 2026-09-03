const Location = require('../models/Location');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Product = require('../models/Product');
const { ACTIVE_COOKIE, ALL, cookieOptions } = require('../middleware/scope');

/**
 * Studios: creating them, and choosing which one you are looking at.
 *
 * Everything that writes here is super-admin only (enforced by the route
 * guard). The one exception is the selector itself, which a super admin
 * uses to move between studios — that is a read plus a cookie, not a write.
 */

// GET /admin/studios — the "Select Your Studio" screen
exports.selector = async (req, res, next) => {
  try {
    const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();

    // A headline number per card, so the choice is informed rather than blind
    const [itemCounts, staffCounts] = await Promise.all([
      Product.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]),
      User.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$location', total: { $sum: 1 } } },
      ]),
    ]);

    const itemMap = itemCounts.reduce((acc, c) => ({ ...acc, [String(c._id)]: c.total }), {});
    const staffMap = staffCounts.reduce((acc, c) => ({ ...acc, [String(c._id)]: c.total }), {});

    studios.forEach((s) => {
      s.itemCount = itemMap[String(s._id)] || 0;
      s.staffCount = staffMap[String(s._id)] || 0;
    });

    res.render('studios/select', {
      title: 'Select your studio',
      layout: 'shell-layout',
      active: 'studios',
      studios,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/studios/open/:id — pick a studio and go to its dashboard
exports.open = async (req, res, next) => {
  try {
    const studio = await Location.findById(req.params.id).lean();
    if (!studio || studio.status !== 'active') {
      return res.redirect('/admin/studios?message=That studio is not available');
    }
    res.cookie(ACTIVE_COOKIE, String(studio._id), cookieOptions());
    res.redirect('/admin/dashboard');
  } catch (err) {
    next(err);
  }
};

// GET /admin/studios/all — leave a studio and look across all of them
exports.openAll = (req, res) => {
  res.cookie(ACTIVE_COOKIE, ALL, cookieOptions());
  res.redirect('/admin/master');
};

/* ---------------- managing studios (super admin only) ---------------- */

// GET /admin/studios/manage
exports.list = async (req, res, next) => {
  try {
    const studios = await Location.find().sort({ status: 1, name: 1 }).lean();

    const [items, staff, admins] = await Promise.all([
      Product.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]),
      User.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]),
      Admin.aggregate([
        { $match: { role: { $ne: 'super' } } },
        { $group: { _id: '$location', total: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [String(r._id)]: r.total }), {});
    const itemMap = toMap(items);
    const staffMap = toMap(staff);
    const adminMap = toMap(admins);

    studios.forEach((s) => {
      s.itemCount = itemMap[String(s._id)] || 0;
      s.staffCount = staffMap[String(s._id)] || 0;
      s.adminCount = adminMap[String(s._id)] || 0;
    });

    res.render('studios/index', {
      title: 'Studios',
      active: 'studios',
      studios,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/studios/new
exports.newForm = (req, res) => {
  res.render('studios/form', {
    title: 'Add studio',
    active: 'studios',
    studio: {},
    themes: Location.THEMES,
    formAction: '/admin/studios',
    isEdit: false,
    error: null,
  });
};

// POST /admin/studios
exports.create = async (req, res) => {
  try {
    const { name, code, city, address, phone, theme } = req.body;
    const studio = await Location.create({
      name,
      code,
      city,
      address,
      phone,
      theme,
      createdBy: req.admin.email,
    });
    res.redirect(
      `/admin/studios/manage?message=${encodeURIComponent(
        `${studio.name} created — add its location admin next so somebody can run it`
      )}`
    );
  } catch (err) {
    const message =
      err.code === 11000
        ? 'A studio with that name or code already exists'
        : err.message;
    res.status(400).render('studios/form', {
      title: 'Add studio',
      active: 'studios',
      studio: req.body,
      themes: Location.THEMES,
      formAction: '/admin/studios',
      isEdit: false,
      error: message,
    });
  }
};

// GET /admin/studios/:id/edit
exports.editForm = async (req, res, next) => {
  try {
    const studio = await Location.findById(req.params.id);
    if (!studio) return res.redirect('/admin/studios/manage?message=Studio not found');

    res.render('studios/form', {
      title: `Edit ${studio.name}`,
      active: 'studios',
      studio,
      themes: Location.THEMES,
      formAction: `/admin/studios/${studio._id}?_method=PUT`,
      isEdit: true,
      error: null,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/studios/:id
exports.update = async (req, res) => {
  try {
    const studio = await Location.findById(req.params.id);
    if (!studio) return res.redirect('/admin/studios/manage?message=Studio not found');

    const { name, city, address, phone, theme } = req.body;
    // The code is deliberately not editable: it is already printed on every
    // asset tag in that studio, and changing it would orphan all of them.
    Object.assign(studio, { name, city, address, phone, theme });
    await studio.save();

    res.redirect('/admin/studios/manage?message=Studio updated');
  } catch (err) {
    const message = err.code === 11000 ? 'A studio with that name already exists' : err.message;
    res.status(400).render('studios/form', {
      title: 'Edit studio',
      active: 'studios',
      studio: { ...req.body, _id: req.params.id, code: req.body.code },
      themes: Location.THEMES,
      formAction: `/admin/studios/${req.params.id}?_method=PUT`,
      isEdit: true,
      error: message,
    });
  }
};

/**
 * PATCH /admin/studios/:id/status — archive or restore.
 *
 * Studios are archived, never deleted. Their items, people and history stay
 * exactly where they are; archiving simply closes the doors, so an accident
 * here loses nothing and can be undone by flipping it back.
 */
exports.toggleStatus = async (req, res, next) => {
  try {
    const studio = await Location.findById(req.params.id);
    if (!studio) return res.redirect('/admin/studios/manage?message=Studio not found');

    studio.status = studio.status === 'active' ? 'archived' : 'active';
    await studio.save();

    // Nobody should be left holding a session into a closed studio
    if (studio.status === 'archived') {
      await Admin.updateMany({ location: studio._id }, { $set: { status: 'inactive' } });
    }

    res.redirect(
      `/admin/studios/manage?message=${encodeURIComponent(
        studio.status === 'archived'
          ? `${studio.name} archived — its admins have been deactivated, and its records are kept`
          : `${studio.name} restored — reactivate its admins from the Admins page`
      )}`
    );
  } catch (err) {
    next(err);
  }
};
