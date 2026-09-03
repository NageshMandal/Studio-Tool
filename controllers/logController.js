const UsageLog = require('../models/UsageLog');
const User = require('../models/User');
const { dayRange, shiftDay } = require('../utils/format');

/**
 * The daily usage log for one studio. Same day-overlap rule as the monthly
 * report: a movement counts for a day if it was open at any point during it,
 * so an overnight loan appears on both days rather than vanishing from one.
 */

// GET /admin/logs?date=YYYY-MM-DD&q=&staff=
exports.daily = async (req, res, next) => {
  try {
    const { iso, start, end } = dayRange(req.query.date);
    const { q, staff } = req.query;

    const filter = req.scope.filter({
      occupiedAt: { $lt: end },
      $or: [{ returnedAt: null }, { returnedAt: { $gte: start } }],
    });

    if (staff) filter.user = staff;

    if (q) {
      filter.$and = [
        {
          $or: [
            { productName: new RegExp(q, 'i') },
            { assetTag: new RegExp(q, 'i') },
            { userName: new RegExp(q, 'i') },
          ],
        },
      ];
    }

    const [logs, staffList] = await Promise.all([
      UsageLog.find(filter).sort({ occupiedAt: -1 }).lean(),
      User.find(req.scope.filter({ status: 'active' }), 'name').sort({ name: 1 }).lean(),
    ]);

    const startedToday = logs.filter((l) => l.occupiedAt >= start && l.occupiedAt < end).length;
    const returnedToday = logs.filter(
      (l) => l.returnedAt && l.returnedAt >= start && l.returnedAt < end
    ).length;
    const stillOut = logs.filter((l) => !l.returnedAt).length;
    const minutes = logs.reduce((sum, l) => sum + (l.durationMinutes || 0), 0);

    // Who moved the most gear today
    const byPerson = {};
    logs.forEach((l) => {
      byPerson[l.userName] = (byPerson[l.userName] || 0) + 1;
    });
    const busiest = Object.entries(byPerson).sort((a, b) => b[1] - a[1])[0];

    const today = dayRange().iso;

    res.render('logs/index', {
      title: 'Usage log',
      active: 'logs',
      logs,
      staffList,
      date: iso,
      isToday: iso === today,
      prevDate: shiftDay(iso, -1),
      nextDate: shiftDay(iso, 1),
      maxDate: today,
      query: { q: q || '', staff: staff || '' },
      summary: {
        startedToday,
        returnedToday,
        stillOut,
        totalHours: Math.round((minutes / 60) * 10) / 10,
        busiest: busiest ? { name: busiest[0], count: busiest[1] } : null,
      },
      message: req.query.message || null,
    });
  } catch (err) {
    next(err);
  }
};
