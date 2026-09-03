const mongoose = require('mongoose');
const Location = require('../models/Location');
const Product = require('../models/Product');
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const ProcurementRequest = require('../models/ProcurementRequest');
const { monthRange, monthLabel, shiftMonth, currentMonthKey } = require('../utils/format');

/**
 * Monthly usage reports.
 *
 * A location admin gets their own studio. A super admin gets any studio,
 * plus a comparison view putting every studio's month side by side.
 *
 * Everything is derived from the usage log rather than from live item state,
 * because the question a monthly report answers is "what happened during
 * March", not "what does the shelf look like today". A report for a past
 * month therefore keeps reading the same however the equipment moves
 * afterwards.
 */

/**
 * Build one studio's report for one month.
 * `monthKey` is 'YYYY-MM'.
 */
async function buildReport(locationId, monthKey) {
  const { start, end } = monthRange(monthKey);
  const locId = new mongoose.Types.ObjectId(String(locationId));

  // Anything that overlapped the month: it went out before the month ended,
  // and either is still out or came back after the month began. A camera
  // taken on the 28th and returned on the 3rd belongs to both months, which
  // is what an honest usage report should say.
  const overlapping = {
    location: locId,
    occupiedAt: { $lt: end },
    $or: [{ returnedAt: null }, { returnedAt: { $gte: start } }],
  };

  // Movements that actually started inside the month — the "how busy were
  // we" number, which should not double-count a long-running loan.
  const startedInMonth = { location: locId, occupiedAt: { $gte: start, $lt: end } };

  const [
    logs,
    startedCount,
    returnedCount,
    stillOut,
    byPerson,
    byCategory,
    byItem,
    requestStats,
    bookingStats,
    procurementStats,
    inventory,
    activeStaff,
  ] = await Promise.all([
    UsageLog.find(overlapping).sort({ occupiedAt: -1 }).lean(),

    UsageLog.countDocuments(startedInMonth),
    UsageLog.countDocuments({ location: locId, returnedAt: { $gte: start, $lt: end } }),
    UsageLog.countDocuments({ location: locId, occupiedAt: { $lt: end }, returnedAt: null }),

    UsageLog.aggregate([
      { $match: startedInMonth },
      {
        $group: {
          _id: { user: '$user', name: '$userName' },
          movements: { $sum: 1 },
          minutes: { $sum: { $ifNull: ['$durationMinutes', 0] } },
        },
      },
      { $sort: { movements: -1 } },
      { $limit: 15 },
    ]),

    UsageLog.aggregate([
      { $match: startedInMonth },
      {
        $group: {
          _id: { $ifNull: ['$category', 'Uncategorised'] },
          movements: { $sum: 1 },
          minutes: { $sum: { $ifNull: ['$durationMinutes', 0] } },
        },
      },
      { $sort: { movements: -1 } },
    ]),

    UsageLog.aggregate([
      { $match: startedInMonth },
      {
        $group: {
          _id: { product: '$product', name: '$productName', tag: '$assetTag' },
          movements: { $sum: 1 },
          minutes: { $sum: { $ifNull: ['$durationMinutes', 0] } },
        },
      },
      { $sort: { movements: -1 } },
      { $limit: 15 },
    ]),

    AssignmentRequest.aggregate([
      { $match: { location: locId, createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$status', total: { $sum: 1 } } },
    ]),

    Booking.aggregate([
      { $match: { location: locId, createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$status', total: { $sum: 1 } } },
    ]),

    ProcurementRequest.aggregate([
      { $match: { location: locId, createdAt: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: '$status',
          total: { $sum: 1 },
          value: { $sum: { $ifNull: ['$approvedBudget', 0] } },
        },
      },
    ]),

    Product.aggregate([
      { $match: { location: locId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          value: { $sum: '$price' },
          out: { $sum: { $cond: [{ $ne: ['$assignedTo', null] }, 1, 0] } },
          maintenance: { $sum: { $cond: [{ $eq: ['$status', 'maintenance'] }, 1, 0] } },
        },
      },
    ]),

    User.countDocuments({ location: locId, status: 'active' }),
  ]);

  const toMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [r._id]: r.total }), {});

  const totalMinutes = logs.reduce((sum, l) => sum + (l.durationMinutes || 0), 0);
  const closed = logs.filter((l) => l.durationMinutes != null);
  const avgMinutes = closed.length ? Math.round(totalMinutes / closed.length) : 0;

  // Movements per day, for the little bar chart on the report page
  const days = {};
  logs
    .filter((l) => l.occupiedAt >= start && l.occupiedAt < end)
    .forEach((l) => {
      const key = new Date(l.occupiedAt).toISOString().slice(0, 10);
      days[key] = (days[key] || 0) + 1;
    });
  const dailyPeak = Math.max(1, ...Object.values(days));
  const daily = Object.entries(days)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count, height: Math.round((count / dailyPeak) * 100) }));

  const inv = inventory[0] || { total: 0, value: 0, out: 0, maintenance: 0 };
  const procMap = procurementStats.reduce((acc, r) => ({ ...acc, [r._id]: r }), {});

  // How many of the studio's items moved at all this month. A low number
  // against a big register is the useful signal here: kit nobody touches.
  const distinctItems = new Set(
    logs.filter((l) => l.occupiedAt >= start && l.occupiedAt < end).map((l) => String(l.product))
  ).size;

  return {
    monthKey,
    monthLabel: monthLabel(monthKey),
    start,
    end,

    summary: {
      movements: startedCount,
      returns: returnedCount,
      stillOut,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      avgHours: Math.round((avgMinutes / 60) * 10) / 10,
      distinctItems,
      activeStaff,
      utilisation: inv.total ? Math.round((distinctItems / inv.total) * 1000) / 10 : 0,
    },

    inventory: {
      total: inv.total,
      value: inv.value,
      out: inv.out,
      maintenance: inv.maintenance,
    },

    requests: {
      total: requestStats.reduce((a, r) => a + r.total, 0),
      ...toMap(requestStats),
    },

    bookings: {
      total: bookingStats.reduce((a, r) => a + r.total, 0),
      ...toMap(bookingStats),
    },

    procurement: {
      total: procurementStats.reduce((a, r) => a + r.total, 0),
      pending: (procMap.pending || {}).total || 0,
      approved: (procMap.approved || {}).total || 0,
      rejected: (procMap.rejected || {}).total || 0,
      received: (procMap.received || {}).total || 0,
      spend: procurementStats.reduce((a, r) => a + (r.value || 0), 0),
    },

    byPerson: byPerson.map((p) => ({
      name: p._id.name || 'Unknown',
      movements: p.movements,
      hours: Math.round((p.minutes / 60) * 10) / 10,
    })),

    byCategory: byCategory.map((c) => ({
      category: c._id,
      movements: c.movements,
      hours: Math.round((c.minutes / 60) * 10) / 10,
    })),

    byItem: byItem.map((i) => ({
      name: i._id.name || 'Unknown',
      assetTag: i._id.tag,
      movements: i.movements,
      hours: Math.round((i.minutes / 60) * 10) / 10,
    })),

    daily,
    logs: logs.slice(0, 100),
  };
}

/**
 * GET /admin/reports
 * One studio's month. A super admin can point it at any studio with ?studio=;
 * everyone else is pinned to their own by the scope.
 */
exports.monthly = async (req, res, next) => {
  try {
    const monthKey = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : currentMonthKey();

    // A super admin may aim the report at any studio; a location admin's
    // scope has already pinned theirs, and the query string cannot move it.
    let locationId = req.scope.activeId;
    if (req.scope.isSuper && req.query.studio) locationId = req.query.studio;

    if (!locationId) {
      return res.redirect('/admin/reports/compare');
    }

    const studio = await Location.findById(locationId).lean();
    if (!studio) return res.redirect('/admin/studios?message=Studio not found');
    if (!req.scope.isSuper && !req.scope.owns({ location: studio._id })) {
      return res.redirect('/admin/dashboard?message=That studio is not yours');
    }

    const report = await buildReport(studio._id, monthKey);

    res.render('reports/monthly', {
      title: `${studio.name} · ${report.monthLabel}`,
      active: 'reports',
      studio,
      report,
      prevMonth: shiftMonth(monthKey, -1),
      nextMonth: shiftMonth(monthKey, 1),
      thisMonth: currentMonthKey(),
      canCompare: req.scope.isSuper,
      studios: req.scope.studios,
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /admin/reports/compare — every studio's month side by side.
 * Super admin only; it is the whole point of being able to see all of them.
 */
exports.compare = async (req, res, next) => {
  try {
    const monthKey = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : currentMonthKey();

    const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();

    const reports = await Promise.all(
      studios.map(async (studio) => ({
        studio,
        report: await buildReport(studio._id, monthKey),
      }))
    );

    const totals = reports.reduce(
      (acc, r) => ({
        movements: acc.movements + r.report.summary.movements,
        hours: Math.round((acc.hours + r.report.summary.totalHours) * 10) / 10,
        items: acc.items + r.report.inventory.total,
        staff: acc.staff + r.report.summary.activeStaff,
        value: acc.value + r.report.inventory.value,
      }),
      { movements: 0, hours: 0, items: 0, staff: 0, value: 0 }
    );

    // Scale the bars against the busiest studio, so the comparison reads
    // at a glance rather than needing the numbers to be studied
    const peak = Math.max(1, ...reports.map((r) => r.report.summary.movements));
    reports.forEach((r) => {
      r.barWidth = Math.round((r.report.summary.movements / peak) * 100);
    });

    res.render('reports/compare', {
      title: `All studios · ${monthLabel(monthKey)}`,
      active: 'reports',
      reports,
      totals,
      monthKey,
      monthLabelText: monthLabel(monthKey),
      prevMonth: shiftMonth(monthKey, -1),
      nextMonth: shiftMonth(monthKey, 1),
      thisMonth: currentMonthKey(),
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /admin/reports/export.csv — the same month as a spreadsheet.
 * Built from the report object rather than a second query, so the file and
 * the page can never disagree.
 */
exports.exportCsv = async (req, res, next) => {
  try {
    const monthKey = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : currentMonthKey();

    let locationId = req.scope.activeId;
    if (req.scope.isSuper && req.query.studio) locationId = req.query.studio;
    if (!locationId) return res.redirect('/admin/reports/compare');

    const studio = await Location.findById(locationId).lean();
    if (!studio) return res.redirect('/admin/reports');

    const report = await buildReport(studio._id, monthKey);

    const escape = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [];
    lines.push(`${studio.name} usage report,${report.monthLabel}`);
    lines.push('');
    lines.push('Summary');
    lines.push(`Movements,${report.summary.movements}`);
    lines.push(`Returns,${report.summary.returns}`);
    lines.push(`Still out at month end,${report.summary.stillOut}`);
    lines.push(`Total hours out,${report.summary.totalHours}`);
    lines.push(`Average hours per movement,${report.summary.avgHours}`);
    lines.push(`Distinct items used,${report.summary.distinctItems}`);
    lines.push(`Items on register,${report.inventory.total}`);
    lines.push(`Utilisation %,${report.summary.utilisation}`);
    lines.push(`Active staff,${report.summary.activeStaff}`);
    lines.push('');
    lines.push('Movements');
    lines.push('Asset tag,Item,Category,Person,Taken,Returned,Hours,Reason');
    report.logs.forEach((l) => {
      lines.push(
        [
          l.assetTag,
          l.productName,
          l.category || '',
          l.userName,
          l.occupiedAt ? new Date(l.occupiedAt).toISOString() : '',
          l.returnedAt ? new Date(l.returnedAt).toISOString() : 'still out',
          l.durationMinutes != null ? Math.round((l.durationMinutes / 60) * 10) / 10 : '',
          l.reason || '',
        ]
          .map(escape)
          .join(',')
      );
    });

    const filename = `${studio.code}-${monthKey}-usage.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
};

exports.buildReport = buildReport;
