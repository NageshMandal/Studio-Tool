const mongoose = require('mongoose');
const Location = require('../models/Location');
const Product = require('../models/Product');
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const ProcurementRequest = require('../models/ProcurementRequest');
const { dayRange, todayKey, TZ } = require('../utils/format');
const masterData = require('../services/masterData');
const approvals = require('../services/approvals');

/**
 * The two dashboards.
 *
 * `dashboard` is one studio: the four headline cards from the design, the
 * live tracker table, and whatever is waiting on an admin.
 *
 * `master` is the super admin's view across every studio at once: a summary
 * card per studio, then one filterable table of activity everywhere. Only a
 * super admin ever reaches it.
 */

/**
 * The numbers behind one studio's cards. Shared by both dashboards, so the
 * master view and the studio view can never disagree about a total.
 */
async function studioStats(locationId) {
  const { start, end } = dayRange();
  const match = { location: new mongoose.Types.ObjectId(String(locationId)) };

  const [
    totalItems,
    assignedItems,
    availableItems,
    maintenanceItems,
    totalStaff,
    takenToday,
    returnedToday,
    pendingRequests,
    pendingBookings,
    pendingCheckIns,
    valueAgg,
  ] = await Promise.all([
    Product.countDocuments(match),
    Product.countDocuments({ ...match, assignedTo: { $ne: null } }),
    Product.countDocuments({ ...match, assignedTo: null, status: 'available' }),
    Product.countDocuments({ ...match, status: 'maintenance' }),
    User.countDocuments({ ...match, status: 'active' }),
    UsageLog.countDocuments({ ...match, occupiedAt: { $gte: start, $lt: end } }),
    UsageLog.countDocuments({ ...match, returnedAt: { $gte: start, $lt: end } }),
    AssignmentRequest.countDocuments({ ...match, status: 'pending' }),
    Booking.countDocuments({ ...match, status: 'pending' }),
    // Handed back, not yet checked in — off the shelf and unavailable
    UsageLog.countDocuments({ ...match, returnedAt: { $ne: null }, acceptedAt: null }),
    Product.aggregate([{ $match: match }, { $group: { _id: null, value: { $sum: '$price' } } }]),
  ]);

  const pct = (n) => (totalItems ? Math.round((n / totalItems) * 1000) / 10 : 0);

  return {
    totalItems,
    assignedItems,
    availableItems,
    maintenanceItems,
    totalStaff,
    takenToday,
    returnedToday,
    pendingRequests,
    pendingBookings,
    pendingCheckIns,
    pendingTotal: pendingRequests + pendingBookings,
    totalValue: valueAgg[0] ? valueAgg[0].value : 0,
    assignedPct: pct(assignedItems),
    availablePct: pct(availableItems),
    maintenancePct: pct(maintenanceItems),
  };
}

// GET /admin/dashboard — one studio
exports.dashboard = async (req, res, next) => {
  try {
    const locationId = req.scope.activeId;
    const studio = req.scope.active;
    const filter = req.scope.filter();

    const stats = await studioStats(locationId);

    const [outNow, recent, todayLogs, openProcurement] = await Promise.all([
      Product.find({ ...filter, assignedTo: { $ne: null } })
        .sort({ occupiedAt: 1 })
        .limit(10)
        .populate('assignedTo', 'name')
        .lean(),

      Product.find(filter).sort({ createdAt: -1 }).limit(6).populate('assignedTo', 'name').lean(),

      UsageLog.find({ ...filter, occupiedAt: { $gte: dayRange().start } })
        .sort({ occupiedAt: -1 })
        .limit(12)
        .lean(),

      // Managers and location admins see their own purchase queue here.
      // A super admin never does — see the ProcurementRequest model.
      req.can.viewProcurement
        ? ProcurementRequest.countDocuments({ ...filter, status: 'pending' })
        : Promise.resolve(0),
    ]);

    res.render('dashboard', {
      title: `${studio.name} dashboard`,
      active: 'dashboard',
      studio,
      stats,
      outNow,
      recent,
      todayLogs,
      openProcurement,
      today: todayKey(),
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /admin/master — every studio at once (super admin only)
exports.master = async (req, res, next) => {
  try {
    const [
      totals,
      { studios },
      issued,
      out,
      pending,
      activity,
      studioRanking,
      categories,
      staffList,
      itemList,
    ] = await Promise.all([
      masterData.headline(),
      masterData.studioMap(),
      masterData.recentIssued(req.query, 8),
      masterData.currentlyOut(6),
      masterData.pendingQueue(),
      masterData.recentActivity(5),
      masterData.topStudios(),
      masterData.categoryBreakdown(),
      User.find({ status: 'active' }, 'name location').sort({ name: 1 }).lean(),
      Product.find({}, 'name assetTag').sort({ name: 1 }).limit(500).lean(),
    ]);

    res.render('master-dashboard', {
      title: 'Master dashboard',
      active: 'master',
      greeting: greetingFor(new Date()),
      totals,
      studios,
      issued: issued.rows,
      issuedTotal: issued.total,
      range: issued.range,
      maxDate: todayKey(),
      out,
      pendingCount: pending.requests.length + pending.bookings.length,
      activity,
      studioRanking,
      categories,
      staffList,
      itemList,
      query: {
        studio: req.query.studio || '',
        staff: req.query.staff || '',
        product: req.query.product || '',
        type: req.query.type || '',
        q: req.query.q || '',
      },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /admin/master/panel/:kind — the contents of the side panel.
 *
 * Returns a fragment, not a page: the dashboard fetches it and slides it in.
 * Every panel is also reachable directly, which is deliberate — it means the
 * drill-downs can be checked without driving a browser, and a panel that
 * fails does so visibly rather than as an empty drawer.
 */
exports.panel = async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '');
    const loader = masterData.PANELS[kind];
    if (!loader) return res.status(404).send('<p class="panel-error">No such panel.</p>');

    const data = await loader(req.query || {});
    if (!data) return res.status(404).send('<p class="panel-error">That record no longer exists.</p>');

    return res.render(`master/panels/${kind}`, {
      ...data,
      layout: false,
      query: req.query || {},
      message: req.query.message || null,
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /admin/master/decide — approve or decline from inside the panel.
 *
 * The super admin has no studio open here, so the usual studio check cannot
 * apply; `null` is passed as the scope on purpose, which the approvals
 * service reads as "no restriction". That is the same authority a super
 * admin already has from inside a studio, not a new one — and it is why this
 * route is super-admin only. Purchase requests are deliberately not
 * decidable here, exactly as they are not anywhere else for a super admin.
 *
 * It answers with the refreshed pending panel so the queue updates in place
 * rather than collapsing the drawer the person is working in.
 */
exports.decide = async (req, res, next) => {
  try {
    const { kind, id, action, note } = req.body;
    const who = (req.admin && (req.admin.email || req.admin.name)) || 'admin';

    let result;
    if (kind === 'booking') {
      result =
        action === 'approve'
          ? await approvals.approveBooking(id, who, null)
          : await approvals.rejectBooking(id, who, note, null);
    } else {
      result =
        action === 'approve'
          ? await approvals.approveRequest(id, who, null)
          : await approvals.rejectRequest(id, who, note, null);
    }

    const data = await masterData.PANELS.pending({});
    return res.render('master/panels/pending', {
      ...data,
      layout: false,
      query: {},
      message: result.message,
    });
  } catch (err) {
    return next(err);
  }
};

// "Good morning" until noon, and so on — the dashboard opens with a greeting
function greetingFor(now) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

exports.studioStats = studioStats;
