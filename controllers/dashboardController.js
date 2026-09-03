const mongoose = require('mongoose');
const Location = require('../models/Location');
const Product = require('../models/Product');
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const ProcurementRequest = require('../models/ProcurementRequest');
const { dayRange, todayKey } = require('../utils/format');

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
    const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();

    // One stats block per studio, gathered in parallel
    const cards = await Promise.all(
      studios.map(async (studio) => ({
        ...studio,
        stats: await studioStats(studio._id),
      }))
    );

    // Company-wide roll-up, so the header is not just a row of separate numbers
    const totals = cards.reduce(
      (acc, c) => ({
        items: acc.items + c.stats.totalItems,
        assigned: acc.assigned + c.stats.assignedItems,
        available: acc.available + c.stats.availableItems,
        staff: acc.staff + c.stats.totalStaff,
        pending: acc.pending + c.stats.pendingTotal,
        value: acc.value + c.stats.totalValue,
      }),
      { items: 0, assigned: 0, available: 0, staff: 0, pending: 0, value: 0 }
    );

    /* ---- the filterable all-studios table ---- */

    const { date, studio: studioFilter, status, staff: staffFilter } = req.query;

    const logFilter = {};
    if (studioFilter) logFilter.location = studioFilter;
    if (date) {
      const { start, end } = dayRange(date);
      logFilter.occupiedAt = { $gte: start, $lt: end };
    }
    if (status === 'out') logFilter.returnedAt = null;
    if (status === 'returned') logFilter.returnedAt = { $ne: null };
    if (staffFilter) logFilter.user = staffFilter;

    const [rows, staffList] = await Promise.all([
      UsageLog.find(logFilter).sort({ occupiedAt: -1 }).limit(60).lean(),
      User.find({ status: 'active' }, 'name location').sort({ name: 1 }).lean(),
    ]);

    res.render('master-dashboard', {
      title: 'Master dashboard',
      active: 'master',
      cards,
      totals,
      rows,
      staffList,
      studios,
      query: {
        date: date || '',
        studio: studioFilter || '',
        status: status || '',
        staff: staffFilter || '',
      },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

exports.studioStats = studioStats;
