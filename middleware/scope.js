const Location = require('../models/Location');

/**
 * Studio scoping — the single gate every admin query passes through.
 *
 * The rule is short: a location admin or manager can only ever see their own
 * studio, and the token says which one. A super admin can see all of them,
 * and picks which studio they are looking at from the studio selector; that
 * choice is remembered in a cookie so it survives a page refresh.
 *
 * Controllers never build a `{ location: ... }` filter by hand. They call
 * `req.scope.filter()` and get the right one for whoever is signed in, which
 * means a new page cannot accidentally leak another studio's data by
 * forgetting a clause.
 */

const ACTIVE_COOKIE = 'activeStudio';
const ALL = 'all';

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

/**
 * Works out the studio context for this request and hangs it off `req.scope`.
 * Runs after `protect`, so `req.admin` is already a live identity.
 */
const withScope = async (req, res, next) => {
  try {
    const admin = req.admin;
    const isSuper = admin.adminRole === 'super';

    // Every active studio, for the selector and the master dashboard.
    // A location admin only ever needs their own, so we don't load the rest.
    const studios = isSuper
      ? await Location.find({ status: 'active' }).sort({ name: 1 }).lean()
      : [];

    let activeId = null;
    let active = null;

    if (isSuper) {
      /**
       * On the API, a super admin picks the studio per request with
       * ?studio=<id> — there is no cookie in a script. On the panel the
       * cookie wins, so clicking through pages does not silently change
       * which studio you are editing based on a stray query string.
       */
      const fromQuery =
        req.originalUrl.startsWith('/api') && req.query && req.query.studio
          ? String(req.query.studio)
          : null;

      const chosen = fromQuery || (req.cookies ? req.cookies[ACTIVE_COOKIE] : null);
      if (chosen && chosen !== ALL) {
        active = studios.find((s) => String(s._id) === String(chosen)) || null;
        // The cookie may point at a studio that has since been archived.
        // A bad ?studio= is the caller's mistake, not a stale session, so it
        // must not wipe the studio they had open in the panel.
        if (!active && !fromQuery) res.clearCookie(ACTIVE_COOKIE);
        activeId = active ? String(active._id) : null;
      }
    } else {
      // Locked to their own studio, whatever any cookie might say
      active = admin.location ? await Location.findById(admin.location).lean() : null;
      if (!active) {
        return res
          .status(403)
          .render('error', {
            title: 'No studio',
            layout: 'auth-layout',
            code: 403,
            message:
              'Your account is not attached to a studio, or that studio has been removed. Ask the super admin to reassign you.',
          });
      }
      if (active.status !== 'active') {
        return res.status(403).render('error', {
          title: 'Studio archived',
          layout: 'auth-layout',
          code: 403,
          message: `${active.name} has been archived by the super admin. Contact them to restore access.`,
        });
      }
      activeId = String(active._id);
    }

    const mode = activeId ? 'one' : 'all';

    req.scope = {
      isSuper,
      mode,
      activeId,
      active,
      studios,

      /**
       * The `{ location: ... }` clause for a query, merged into whatever
       * else the caller needs. Returns `{}` only for a super admin who is
       * deliberately looking across every studio.
       */
      filter(extra = {}) {
        return activeId ? { ...extra, location: activeId } : { ...extra };
      },

      /**
       * Guard for a document that has already been loaded: true when this
       * admin is allowed to touch it. Used on every :id route so an id from
       * another studio, pasted into the URL, is refused.
       */
      owns(doc) {
        if (!doc) return false;
        const docLocation = doc.location && doc.location._id ? doc.location._id : doc.location;
        if (!activeId) return isSuper; // super admin in all-studios mode
        return String(docLocation) === String(activeId);
      },
    };

    res.locals.scope = req.scope;
    res.locals.activeStudio = active;
    res.locals.studios = studios;

    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * For pages that only make sense inside one studio (the dashboard, the
 * item register, the requests queue). A super admin who has not picked a
 * studio yet is sent to the selector rather than shown a broken page.
 */
const requireStudio = (req, res, next) => {
  if (req.scope && req.scope.activeId) return next();
  return res.redirect('/admin/studios?message=Pick a studio to open first');
};

/**
 * Refuses a document that belongs to another studio. Controllers call this
 * right after loading by id.
 */
const assertOwned = (req, res, doc, redirectTo) => {
  if (req.scope.owns(doc)) return true;
  res.redirect(`${redirectTo}?message=${encodeURIComponent('That record belongs to another studio')}`);
  return false;
};

module.exports = { withScope, requireStudio, assertOwned, ACTIVE_COOKIE, ALL, cookieOptions };
