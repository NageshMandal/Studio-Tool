const UsageLog = require('../models/UsageLog');
const User = require('../models/User');
const { resolveRange, shiftRange, rangeQuery, todayKey, searchRegex } = require('../utils/format');

/**
 * The usage log for one studio, over a chosen period.
 *
 * The overlap rule is the same one the monthly report uses: a movement counts
 * if it was open at any point during the window, so an overnight loan shows up
 * on both of its days rather than falling out of one of them. That rule reads
 * identically whether the window is a day or a quarter, which is why widening
 * this from a single date to a range needed no change to the query shape.
 */

// A long range on a busy studio can return a great many rows. The page is a
// reading surface, not an export, so it is capped and says so.
const ROW_LIMIT = 500;

// GET /admin/logs?from=&to=&range=&q=&staff=
exports.daily = async (req, res, next) => {
  try {
    const range = resolveRange(req.query, 'today');
    const { q, staff } = req.query;

    const filter = req.scope.filter();

    // Open at any point during the window. Either bound may be absent, which
    // is what "all time" and the open-ended ranges mean.
    if (range.end) filter.occupiedAt = { $lt: range.end };
    if (range.start) {
      filter.$or = [{ returnedAt: null }, { returnedAt: { $gte: range.start } }];
    }

    if (staff) filter.user = staff;

    const rx = searchRegex(q);
    if (rx) {
      filter.$and = [
        {
          $or: [
            { productName: rx },
            { assetTag: rx },
            { userName: rx },
          ],
        },
      ];
    }

    const [logs, totalCount, staffList] = await Promise.all([
      UsageLog.find(filter).sort({ occupiedAt: -1 }).limit(ROW_LIMIT).lean(),
      UsageLog.countDocuments(filter),
      User.find(req.scope.filter({ status: 'active' }), 'name').sort({ name: 1 }).lean(),
    ]);

    /**
     * The summary counts movements that started and finished inside the
     * window, not every row on screen. A loan carried in from before the
     * window was not "taken out" during it, and saying otherwise would make
     * the four figures disagree with the table under them.
     */
    const within = (when) =>
      Boolean(when) &&
      (!range.start || when >= range.start) &&
      (!range.end || when < range.end);

    const started = logs.filter((l) => within(l.occupiedAt)).length;
    const returned = logs.filter((l) => within(l.returnedAt)).length;
    const stillOut = logs.filter((l) => !l.returnedAt).length;
    const minutes = logs.reduce((sum, l) => sum + (l.durationMinutes || 0), 0);

    // Who moved the most gear over the period
    const byPerson = {};
    logs.forEach((l) => {
      byPerson[l.userName] = (byPerson[l.userName] || 0) + 1;
    });
    const busiest = Object.entries(byPerson).sort((a, b) => b[1] - a[1])[0];

    const today = todayKey();
    const prev = shiftRange(range, -1);
    const next = shiftRange(range, 1);

    res.render('logs/index', {
      title: 'Usage log',
      active: 'logs',
      logs,
      staffList,
      range,
      // Stepping keeps whatever else was filtered, so ‹ › does not quietly
      // drop the person or the search you had chosen
      prevUrl: prev ? `/admin/logs${rangeQuery(req.query, prev)}` : null,
      nextUrl: next ? `/admin/logs${rangeQuery(req.query, next)}` : null,
      resetUrl: '/admin/logs',
      maxDate: today,
      isToday: range.isSingleDay && range.from === today,
      truncated: totalCount > logs.length,
      totalCount,
      rowLimit: ROW_LIMIT,
      query: { q: q || '', staff: staff || '' },
      summary: {
        startedToday: started,
        returnedToday: returned,
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
