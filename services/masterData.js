const mongoose = require('mongoose');
const Location = require('../models/Location');
const Product = require('../models/Product');
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const AssignmentRequest = require('../models/AssignmentRequest');
const Booking = require('../models/Booking');
const { resolveRange, rangeClause } = require('../utils/format');

/**
 * Everything the master dashboard and its side panels read.
 *
 * It lives here rather than in the controller because the same queries are
 * needed twice: once to paint the page, and again when a panel is opened or
 * a request is decided inside one. Keeping them in one place is what stops
 * the card saying "6 pending" while the panel behind it lists five.
 */

const PANEL_LIMIT = 200;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** A studio id -> name/theme lookup, for rows that only store the id. */
async function studioMap() {
  const studios = await Location.find({ status: 'active' }).sort({ name: 1 }).lean();
  const byId = studios.reduce((acc, s) => ({ ...acc, [String(s._id)]: s }), {});
  return { studios, byId };
}

/**
 * Builds the movement filter from the dashboard's filter bar.
 *
 * The bar drives the movement lists — issued items and activity. It does not
 * touch the headline cards: those are counts of how things stand right now,
 * and quietly reinterpreting "36 items" as "36 items in the chosen period"
 * would make two true numbers look like a contradiction.
 */
function movementFilter(query) {
  const range = resolveRange(query, '30d');
  const filter = { ...rangeClause('occupiedAt', range) };

  if (query.studio) filter.location = query.studio;
  if (query.staff) filter.user = query.staff;
  if (query.product) filter.product = query.product;

  // Transaction type: an issue is any movement, a return is one that came back
  if (query.type === 'return') filter.returnedAt = { $ne: null };
  if (query.type === 'issue') filter.returnedAt = null;

  if (query.q) {
    const rx = new RegExp(String(query.q).trim(), 'i');
    filter.$or = [{ productName: rx }, { assetTag: rx }, { userName: rx }, { locationName: rx }];
  }

  return { range, filter };
}

/* ---------------- headline numbers ---------------- */

/**
 * The six cards along the top. Every one is a count of the present, so they
 * stay put when the filter bar changes — see movementFilter above.
 */
async function headline() {
  const [studioCount, totalItems, staffCount, outNow, pendingRequests, pendingBookings, valueAgg, addedThisMonth] =
    await Promise.all([
      Location.countDocuments({ status: 'active' }),
      Product.countDocuments({}),
      User.countDocuments({ status: 'active' }),
      Product.countDocuments({ assignedTo: { $ne: null } }),
      AssignmentRequest.countDocuments({ status: 'pending' }),
      Booking.countDocuments({ status: 'pending' }),
      Product.aggregate([{ $group: { _id: null, value: { $sum: '$price' } } }]),
      Product.countDocuments({
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      }),
    ]);

  return {
    studioCount,
    totalItems,
    staffCount,
    outNow,
    outPct: totalItems ? Math.round((outNow / totalItems) * 1000) / 10 : 0,
    pendingRequests,
    pendingBookings,
    pendingTotal: pendingRequests + pendingBookings,
    totalValue: valueAgg[0] ? valueAgg[0].value : 0,
    addedThisMonth,
  };
}

/* ---------------- the page's lists ---------------- */

async function recentIssued(query, limit = 8) {
  const { range, filter } = movementFilter(query);
  const [rows, total] = await Promise.all([
    UsageLog.find(filter).sort({ occupiedAt: -1 }).limit(limit).lean(),
    UsageLog.countDocuments(filter),
  ]);
  return { rows, total, range };
}

/** Items with somebody holding them right now, newest first. */
async function currentlyOut(limit = PANEL_LIMIT) {
  return Product.find({ assignedTo: { $ne: null } })
    .sort({ occupiedAt: 1 })
    .limit(limit)
    .populate('assignedTo', 'name department designation')
    .lean();
}

/** Both kinds of approval waiting on somebody, oldest first. */
async function pendingQueue() {
  const [requests, bookings] = await Promise.all([
    AssignmentRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean(),
    Booking.find({ status: 'pending' }).sort({ bookedFor: 1, createdAt: 1 }).lean(),
  ]);
  return { requests, bookings };
}

/**
 * One merged stream of what has happened lately, drawn from the three places
 * things actually happen. Merged and re-sorted rather than shown as three
 * separate lists, because "what changed recently" is one question.
 */
async function recentActivity(limit = 8) {
  const [logs, requests, bookings] = await Promise.all([
    UsageLog.find({}).sort({ occupiedAt: -1 }).limit(limit * 2).lean(),
    AssignmentRequest.find({}).sort({ createdAt: -1 }).limit(limit).lean(),
    Booking.find({}).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);

  const events = [];

  logs.forEach((l) => {
    events.push({
      tone: 'blue',
      at: l.occupiedAt,
      who: l.userName,
      verb: 'took out',
      what: l.productName,
      where: l.locationName,
    });
    if (l.returnedAt) {
      events.push({
        tone: 'green',
        at: l.returnedAt,
        who: l.userName,
        verb: 'returned',
        what: l.productName,
        where: l.locationName,
      });
    }
  });

  requests.forEach((r) => {
    events.push({
      tone: r.status === 'pending' ? 'amber' : 'grey',
      at: r.decidedAt || r.createdAt,
      who: r.userName,
      verb: r.status === 'pending' ? 'requested' : `had a request ${r.status}`,
      what: r.productName,
      where: r.locationName,
    });
  });

  bookings.forEach((b) => {
    events.push({
      tone: b.status === 'pending' ? 'amber' : 'grey',
      at: b.decidedAt || b.createdAt,
      who: b.userName,
      verb: b.status === 'pending' ? 'booked' : `had a booking ${b.status}`,
      what: b.productName,
      where: b.locationName,
    });
  });

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

/** Studios ranked by how much kit they hold. */
async function topStudios() {
  const { studios } = await studioMap();
  const counts = await Product.aggregate([{ $group: { _id: '$location', total: { $sum: 1 } } }]);
  const byId = counts.reduce((acc, c) => ({ ...acc, [String(c._id)]: c.total }), {});

  return studios
    .map((s) => ({ ...s, itemCount: byId[String(s._id)] || 0 }))
    .sort((a, b) => b.itemCount - a.itemCount);
}

/** How the register splits by category, with each share of the total. */
async function categoryBreakdown() {
  const rows = await Product.aggregate([
    { $group: { _id: '$category', total: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const total = rows.reduce((sum, r) => sum + r.total, 0);

  return rows.map((r) => ({
    category: r._id || 'Uncategorised',
    total: r.total,
    pct: total ? Math.round((r.total / total) * 100) : 0,
  }));
}

/* ---------------- panel filtering ---------------- */

/**
 * The dropdown contents every panel's filter bar needs. Loaded once per
 * panel request rather than baked into the dashboard, because a studio or
 * category added since the page was opened should still be selectable.
 */
async function filterOptions() {
  const [{ studios }, categories] = await Promise.all([studioMap(), categoryBreakdown()]);
  return {
    studioOptions: [{ value: '', label: 'All studios' }].concat(
      studios.map((s) => ({ value: String(s._id), label: s.name }))
    ),
    categoryOptions: [{ value: '', label: 'All categories' }].concat(
      categories.map((c) => ({ value: c.category, label: c.category }))
    ),
  };
}

/** Case-insensitive contains, for the panels that filter in memory. */
const matches = (text, q) => String(text || '').toLowerCase().includes(String(q).trim().toLowerCase());

/* ---------------- panel loaders ---------------- */

/**
 * The data behind each side panel. Keyed by panel name so the route stays a
 * lookup rather than a growing switch, and so an unknown name is a plain
 * "not found" instead of a crash.
 */
const PANELS = {
  async studios(query) {
    let studios = await topStudios();
    if (query.q) {
      studios = studios.filter(
        (s) => matches(s.name, query.q) || matches(s.code, query.q) || matches(s.city, query.q)
      );
    }
    return {
      studios,
      fields: [{ type: 'search', name: 'q', label: 'Find a studio', placeholder: 'Name, code or city' }],
    };
  },

  async items(query) {
    const filter = {};
    if (query.studio) filter.location = query.studio;
    if (query.category) filter.category = query.category;
    if (query.status === 'out') filter.assignedTo = { $ne: null };
    // Nobody holds a pending-return item, but it is not available either
    if (query.status === 'available') {
      filter.assignedTo = null;
      filter.status = 'available';
    }
    if (query.status === 'pending-return') filter.status = 'pending-return';
    if (query.q) {
      const rx = new RegExp(String(query.q).trim(), 'i');
      filter.$or = [{ name: rx }, { assetTag: rx }, { brand: rx }, { model: rx }];
    }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort({ name: 1 })
        .limit(PANEL_LIMIT)
        .populate('assignedTo', 'name')
        .lean(),
      Product.countDocuments(filter),
    ]);

    const { byId } = await studioMap();
    items.forEach((i) => {
      i.studioName = byId[String(i.location)] ? byId[String(i.location)].name : '—';
    });

    const { studioOptions, categoryOptions } = await filterOptions();

    return {
      items,
      total,
      truncated: total > items.length,
      category: query.category || null,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Name, tag or brand' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
        { type: 'select', name: 'category', label: 'Category', options: categoryOptions },
        {
          type: 'select',
          name: 'status',
          label: 'Status',
          options: [
            { value: '', label: 'Any status' },
            { value: 'available', label: 'Available' },
            { value: 'out', label: 'Out with someone' },
            { value: 'pending-return', label: 'Waiting to be checked in' },
          ],
        },
      ],
    };
  },

  async out(query) {
    let items = await currentlyOut();
    const { byId } = await studioMap();
    items.forEach((i) => {
      i.studioName = byId[String(i.location)] ? byId[String(i.location)].name : '—';
    });

    if (query.studio) items = items.filter((i) => String(i.location) === String(query.studio));
    if (query.q) {
      // The holder's name is searchable too — "who has what" is usually asked
      // from the person's end, not the item's
      items = items.filter(
        (i) =>
          matches(i.name, query.q) ||
          matches(i.assetTag, query.q) ||
          matches(i.assignedTo && i.assignedTo.name, query.q)
      );
    }

    const { studioOptions } = await filterOptions();
    return {
      items,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Item, tag or who has it' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
      ],
    };
  },

  async pending(query) {
    let { requests, bookings } = await pendingQueue();

    if (query.studio) {
      requests = requests.filter((r) => String(r.location) === String(query.studio));
      bookings = bookings.filter((b) => String(b.location) === String(query.studio));
    }
    if (query.q) {
      const hit = (r) => matches(r.productName, query.q) || matches(r.assetTag, query.q) || matches(r.userName, query.q);
      requests = requests.filter(hit);
      bookings = bookings.filter(hit);
    }
    if (query.kind === 'requests') bookings = [];
    if (query.kind === 'bookings') requests = [];

    const { studioOptions } = await filterOptions();
    return {
      requests,
      bookings,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Item, tag or person' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
        {
          type: 'select',
          name: 'kind',
          label: 'Kind',
          options: [
            { value: '', label: 'Requests and bookings' },
            { value: 'requests', label: 'Item requests only' },
            { value: 'bookings', label: 'Bookings only' },
          ],
        },
      ],
    };
  },

  async issued(query) {
    const { rows, total, range } = await recentIssued(query, PANEL_LIMIT);
    const { studioOptions } = await filterOptions();

    return {
      rows,
      total,
      range,
      truncated: total > rows.length,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Item, tag, person or studio' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
        {
          type: 'select',
          name: 'type',
          label: 'Transaction',
          options: [
            { value: '', label: 'All (issue / return)' },
            { value: 'issue', label: 'Still out' },
            { value: 'return', label: 'Returned' },
          ],
        },
      ],
    };
  },

  async activity(query) {
    let events = await recentActivity(60);
    if (query.q) {
      events = events.filter(
        (e) => matches(e.who, query.q) || matches(e.what, query.q) || matches(e.where, query.q)
      );
    }
    return {
      events: events.slice(0, 40),
      fields: [{ type: 'search', name: 'q', label: 'Search', placeholder: 'Person, item or studio' }],
    };
  },

  async employees(query) {
    const filter = {};
    if (query.studio) filter.location = query.studio;
    if (query.status) filter.status = query.status;
    if (query.q) filter.name = new RegExp(String(query.q).trim(), 'i');

    const [users, total] = await Promise.all([
      User.find(filter).sort({ name: 1 }).limit(PANEL_LIMIT).lean(),
      User.countDocuments(filter),
    ]);

    const { byId } = await studioMap();
    users.forEach((u) => {
      u.studioName = byId[String(u.location)] ? byId[String(u.location)].name : '—';
    });

    const { studioOptions } = await filterOptions();
    return {
      users,
      total,
      truncated: total > users.length,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Name' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
        {
          type: 'select',
          name: 'status',
          label: 'Status',
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        },
      ],
    };
  },

  async categories(query) {
    let categories = await categoryBreakdown();
    if (query.q) categories = categories.filter((c) => matches(c.category, query.q));
    return {
      categories,
      fields: [{ type: 'search', name: 'q', label: 'Find a category', placeholder: 'Camera, lens…' }],
    };
  },

  async value(query) {
    const filter = { price: { $gt: 0 } };
    if (query.studio) filter.location = query.studio;
    if (query.category) filter.category = query.category;
    if (query.q) {
      const rx = new RegExp(String(query.q).trim(), 'i');
      filter.$or = [{ name: rx }, { assetTag: rx }, { brand: rx }];
    }

    const items = await Product.find(filter).sort({ price: -1 }).limit(PANEL_LIMIT).lean();

    const { byId } = await studioMap();
    items.forEach((i) => {
      i.studioName = byId[String(i.location)] ? byId[String(i.location)].name : '—';
    });

    /**
     * The total follows the filter. A heading that always showed the whole
     * register's value while the list below it showed one studio's would be
     * two numbers that look like they disagree.
     */
    const agg = await Product.aggregate([
      { $match: filter },
      { $group: { _id: null, value: { $sum: '$price' } } },
    ]);

    const { studioOptions, categoryOptions } = await filterOptions();
    return {
      items,
      totalValue: agg[0] ? agg[0].value : 0,
      fields: [
        { type: 'search', name: 'q', label: 'Search', placeholder: 'Name, tag or brand' },
        { type: 'select', name: 'studio', label: 'Studio', options: studioOptions },
        { type: 'select', name: 'category', label: 'Category', options: categoryOptions },
      ],
    };
  },

  async item(query) {
    if (!query.id || !mongoose.isValidObjectId(query.id)) return null;
    const item = await Product.findById(query.id).populate('assignedTo', 'name department').lean();
    if (!item) return null;

    const { byId } = await studioMap();
    item.studioName = byId[String(item.location)] ? byId[String(item.location)].name : '—';

    const history = await UsageLog.find({ product: item._id })
      .sort({ occupiedAt: -1 })
      .limit(10)
      .lean();

    return { item, history };
  },

  async employee(query) {
    if (!query.id || !mongoose.isValidObjectId(query.id)) return null;
    const user = await User.findById(query.id).lean();
    if (!user) return null;

    const { byId } = await studioMap();
    user.studioName = byId[String(user.location)] ? byId[String(user.location)].name : '—';

    const [holding, history] = await Promise.all([
      Product.find({ assignedTo: user._id }).lean(),
      UsageLog.find({ user: user._id }).sort({ occupiedAt: -1 }).limit(10).lean(),
    ]);

    return { user, holding, history };
  },
};

module.exports = {
  PANELS,
  PANEL_LIMIT,
  headline,
  movementFilter,
  recentIssued,
  currentlyOut,
  pendingQueue,
  recentActivity,
  topStudios,
  categoryBreakdown,
  studioMap,
  filterOptions,
  oid,
};
