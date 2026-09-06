const Location = require('../models/Location');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Product = require('../models/Product');
const { ACTIVE_COOKIE, ALL, cookieOptions } = require('../middleware/scope');

/**
 * Studios: one page does everything.
 *
 * There used to be two screens — a picker at /admin/studios and a management
 * table at /admin/studios/manage — plus a third for the add/edit form. Opening
 * a studio, adding one and correcting a typo in its address were three
 * different places, so the super admin bounced between them constantly.
 *
 * Now `/admin/studios` is the only studio screen. It lists every studio as a
 * card you can open, edit or archive on the spot; adding and editing happen in
 * a dialog on that same page, so nothing here navigates away. The old URLs
 * still resolve — they redirect back to the hub with the right dialog open —
 * so bookmarks and links from other pages keep working.
 *
 * Everything that writes is super-admin only (enforced by the route guard).
 * The hub itself is open to any admin; a location admin simply sees their own
 * studio and none of the management controls.
 */

/**
 * Every studio plus the three headline numbers each card shows. One pass for
 * the whole page, rather than a query per studio.
 */
async function loadStudios() {
  const studios = await Location.find().sort({ status: 1, name: 1 }).lean();

  const [items, staff, admins] = await Promise.all([
    Product.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]),
    User.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$location', total: { $sum: 1 } } },
    ]),
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

  return studios;
}

/**
 * Renders the hub.
 *
 * `form` decides whether the add/edit dialog is open when the page paints:
 * null for a plain visit, or `{ mode, studio, error }` when the super admin
 * asked for it or a save came back rejected. Handing the submitted values
 * straight back means a validation error never costs somebody their typing.
 *
 * The layout switches on context. Somebody who has not opened a studio yet
 * gets the chrome-free screen — a sidebar full of studio-scoped links would be
 * lying at that point. Somebody who arrived from inside a studio keeps their
 * sidebar, so "Studios" in the nav no longer feels like being thrown out.
 */
function renderHub(req, res, studios, options) {
  const opts = options || {};
  const hasContext =
    Boolean(req.scope.activeId) ||
    Boolean(req.cookies && req.cookies[ACTIVE_COOKIE] === ALL);

  return res.status(opts.status || 200).render('studios/index', {
    title: 'Studios',
    layout: hasContext ? 'layout' : 'shell-layout',
    active: 'studios',
    bare: !hasContext,
    studios,
    themes: Location.THEMES,
    form: opts.form || null,
    // Deliberately not called `message`: the sidebar layout renders that one
    // itself, and the page needs to own the banner so both layouts agree.
    flash: req.query.message || null,
  });
}

// GET /admin/studios — the one studio screen
exports.hub = async (req, res, next) => {
  try {
    const all = await loadStudios();

    // A location admin sees only their own studio, and only to open it
    const studios = req.can.manageStudios
      ? all
      : all.filter((s) => String(s._id) === String(req.scope.activeId));

    // ?form=new and ?form=edit&id=… are how the old add and edit URLs land here
    let form = null;
    if (req.can.manageStudios && req.query.form === 'new') {
      form = { mode: 'new', studio: {}, error: null };
    } else if (req.can.manageStudios && req.query.form === 'edit' && req.query.id) {
      const studio = studios.find((s) => String(s._id) === String(req.query.id));
      if (studio) form = { mode: 'edit', studio, error: null };
    }

    return renderHub(req, res, studios, { form });
  } catch (err) {
    return next(err);
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
    return res.redirect('/admin/dashboard');
  } catch (err) {
    return next(err);
  }
};

// GET /admin/studios/all — leave a studio and look across all of them
exports.openAll = (req, res) => {
  res.cookie(ACTIVE_COOKIE, ALL, cookieOptions());
  res.redirect('/admin/master');
};

/* ---------------- old URLs, kept alive ---------------- */

// GET /admin/studios/manage — the management table lives in the hub now
exports.list = (req, res) => res.redirect('/admin/studios');

// GET /admin/studios/new — the form is a dialog on the hub now
exports.newForm = (req, res) => res.redirect('/admin/studios?form=new');

// GET /admin/studios/:id/edit — likewise
exports.editForm = (req, res) =>
  res.redirect('/admin/studios?form=edit&id=' + encodeURIComponent(req.params.id));

/* ---------------- writes (super admin only) ---------------- */

// POST /admin/studios
exports.create = async (req, res, next) => {
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

    return res.redirect(
      '/admin/studios?message=' +
        encodeURIComponent(
          studio.name + ' created — add its location admin next so somebody can run it'
        )
    );
  } catch (err) {
    if (err.name !== 'ValidationError' && err.code !== 11000) return next(err);

    // Straight back to the hub, dialog still open and still filled in
    try {
      const studios = await loadStudios();
      return renderHub(req, res, studios, {
        status: 400,
        form: {
          mode: 'new',
          studio: req.body,
          error:
            err.code === 11000
              ? 'A studio with that name or code already exists'
              : err.message,
        },
      });
    } catch (loadErr) {
      return next(loadErr);
    }
  }
};

// PUT /admin/studios/:id
exports.update = async (req, res, next) => {
  try {
    const studio = await Location.findById(req.params.id);
    if (!studio) return res.redirect('/admin/studios?message=Studio not found');

    const { name, city, address, phone, theme } = req.body;
    // The code is deliberately not editable: it is already printed on every
    // asset tag in that studio, and changing it would orphan all of them.
    Object.assign(studio, { name, city, address, phone, theme });
    await studio.save();

    return res.redirect(
      '/admin/studios?message=' + encodeURIComponent(studio.name + ' updated')
    );
  } catch (err) {
    if (err.name !== 'ValidationError' && err.code !== 11000) return next(err);

    try {
      const studios = await loadStudios();
      const original = studios.find((s) => String(s._id) === String(req.params.id));
      return renderHub(req, res, studios, {
        status: 400,
        form: {
          mode: 'edit',
          studio: Object.assign({}, req.body, {
            _id: req.params.id,
            code: original ? original.code : req.body.code,
          }),
          error:
            err.code === 11000
              ? 'A studio with that name already exists'
              : err.message,
        },
      });
    } catch (loadErr) {
      return next(loadErr);
    }
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
    if (!studio) return res.redirect('/admin/studios?message=Studio not found');

    studio.status = studio.status === 'active' ? 'archived' : 'active';
    await studio.save();

    if (studio.status === 'archived') {
      // Nobody should be left holding a session into a closed studio
      await Admin.updateMany({ location: studio._id }, { $set: { status: 'inactive' } });

      // Nor should the super admin still be "inside" the studio they just shut
      if (String(req.scope.activeId) === String(studio._id)) {
        res.clearCookie(ACTIVE_COOKIE);
      }
    }

    return res.redirect(
      '/admin/studios?message=' +
        encodeURIComponent(
          studio.status === 'archived'
            ? studio.name +
                ' archived — its admins have been deactivated, and its records are kept'
            : studio.name + ' restored — reactivate its admins from the Admins page'
        )
    );
  } catch (err) {
    return next(err);
  }
};
