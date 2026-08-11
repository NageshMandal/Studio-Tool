const UsageLog = require('../models/UsageLog');
const { dayRange, shiftDay } = require('../utils/format');

// GET /admin/logs?date=YYYY-MM-DD&user=&q=
exports.daily = async (req, res, next) => {
  try {
    const { iso, start, end } = dayRange(req.query.date);
    const { q } = req.query;

    // Everything that overlaps the chosen day: started before it ended,
    // and either still open or returned after the day began.
    const filter = {
      occupiedAt: { $lt: end },
      $or: [{ returnedAt: null }, { returnedAt: { $gte: start } }],
    };

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

    const logs = await UsageLog.find(filter).sort({ occupiedAt: -1 }).lean();

    const startedToday = logs.filter((l) => l.occupiedAt >= start && l.occupiedAt < end).length;
    const returnedToday = logs.filter((l) => l.returnedAt && l.returnedAt >= start && l.returnedAt < end).length;
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
      date: iso,
      isToday: iso === today,
      prevDate: shiftDay(iso, -1),
      nextDate: shiftDay(iso, 1),
      maxDate: today,
      query: { q: q || '' },
      summary: {
        startedToday,
        returnedToday,
        stillOut,
        totalHours: Math.round((minutes / 60) * 10) / 10,
        busiest: busiest ? { name: busiest[0], count: busiest[1] } : null,
      },
    });
  } catch (err) {
    next(err);
  }
};
