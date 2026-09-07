const TZ = process.env.TIMEZONE || 'Asia/Kolkata';

// "10 Aug, 2:15 pm"
function formatWhen(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-IN', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "2:15 pm"
function formatTime(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-IN', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 135 -> "2h 15m"
function formatDuration(minutes) {
  if (minutes == null) return '—';
  const mins = Math.max(0, Math.round(minutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// How long ago something started, in the same style
function formatSince(date) {
  if (!date) return '—';
  return formatDuration((Date.now() - new Date(date).getTime()) / 60000);
}

// Day boundaries in the configured timezone, returned as UTC Date objects
function dayRange(dateString) {
  const base = dateString ? new Date(`${dateString}T00:00:00`) : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const get = (t) => parts.find((p) => p.type === t).value;
  const iso = dateString || `${get('year')}-${get('month')}-${get('day')}`;

  // Offset of the target timezone, so "midnight there" maps to the right instant
  const probe = new Date(`${iso}T12:00:00Z`);
  const local = new Date(probe.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = local - utc;

  const start = new Date(new Date(`${iso}T00:00:00Z`).getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { iso, start, end };
}

function shiftDay(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---- Month keys, for the monthly reports ---------------------------- *
 * A month is a 'YYYY-MM' key in the configured timezone. The same offset
 * trick as dayRange is used, so "March at this studio" starts at local
 * midnight on the 1st rather than at UTC midnight.
 */

// The month a given instant falls in, in the configured timezone
function monthKeyOf(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date(date))
    .slice(0, 7);
}

const currentMonthKey = () => monthKeyOf(new Date());

// The offset of the configured timezone at a given instant, in ms
function offsetAt(isoDate) {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const local = new Date(probe.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local - utc;
}

/** '2026-03' -> the UTC instants the local month starts and ends at. */
function monthRange(monthKey) {
  const key = /^\d{4}-\d{2}$/.test(monthKey || '') ? monthKey : currentMonthKey();
  const [year, month] = key.split('-').map(Number);

  const firstIso = `${key}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  const nextIso = `${nextMonth}-01`;

  const start = new Date(new Date(`${firstIso}T00:00:00Z`).getTime() - offsetAt(firstIso));
  const end = new Date(new Date(`${nextIso}T00:00:00Z`).getTime() - offsetAt(nextIso));

  return { key, start, end };
}

// '2026-03' -> 'March 2026'
function monthLabel(monthKey) {
  const key = /^\d{4}-\d{2}$/.test(monthKey || '') ? monthKey : currentMonthKey();
  return new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

// Step a month key forwards or backwards
function shiftMonth(monthKey, delta) {
  const key = /^\d{4}-\d{2}$/.test(monthKey || '') ? monthKey : currentMonthKey();
  const [year, month] = key.split('-').map(Number);
  const total = year * 12 + (month - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/* ---- Date ranges, for every filter that picks a period ---------------- *
 * One resolver behind the tracker, the usage log and the master dashboard,
 * so "last 7 days" means the same thing on all three and a fix lands once.
 *
 * A range is two day keys plus the UTC instants those local days start and
 * end at. Either end may be open: null `from` means "everything up to `to`",
 * null on both means all time.
 */

const RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' },
];

const isDayKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

/**
 * Works out the period a request is asking for.
 *
 * Precedence is deliberate and is what lets the preset buttons work without
 * any JavaScript: an explicit `range` preset always wins over the from/to
 * boxes. The preset buttons submit `range`, the plain Filter button does not,
 * so whichever the person actually pressed is the one that counts.
 *
 * `date=YYYY-MM-DD` is the old single-day parameter. It still resolves, to a
 * range of that one day, so existing links and bookmarks keep working.
 */
function resolveRange(query, defaultPreset = 'today') {
  const q = query || {};
  const today = todayKey();
  const asked = String(q.range || '').trim();

  // A caller can only default to a real preset. Without this, a typo could
  // send the "cleared the boxes" fallback below into infinite recursion.
  const fallback = RANGE_PRESETS.some((p) => p.key === defaultPreset) ? defaultPreset : 'today';

  // Read the boxes into locals rather than writing back onto req.query,
  // which the view and other handlers still read from
  let askedFrom = isDayKey(q.from) ? q.from : null;
  let askedTo = isDayKey(q.to) ? q.to : null;

  let preset;
  if (asked && asked !== 'custom' && RANGE_PRESETS.some((p) => p.key === asked)) {
    preset = asked;
  } else if (asked === 'custom' || askedFrom || askedTo) {
    preset = 'custom';
  } else if (isDayKey(q.date)) {
    preset = 'custom';
    askedFrom = q.date;
    askedTo = q.date;
  } else {
    preset = fallback;
  }

  let from = null;
  let to = null;

  switch (preset) {
    case 'all':
      break;
    case 'yesterday':
      from = to = shiftDay(today, -1);
      break;
    case '7d':
      from = shiftDay(today, -6);
      to = today;
      break;
    case '30d':
      from = shiftDay(today, -29);
      to = today;
      break;
    case 'month':
      from = `${today.slice(0, 7)}-01`;
      to = today;
      break;
    case 'custom':
      from = askedFrom;
      to = askedTo;
      /**
       * Both boxes empty, or filled with something that is not a date, is
       * somebody clearing the filter — not asking for every movement ever
       * recorded. Falling back to the page's own default keeps that from
       * turning into an unbounded query by accident; "All time" is still
       * available, but only by pressing the button that says so.
       */
      if (!from && !to) return resolveRange({ range: fallback }, fallback);
      break;
    case 'today':
    default:
      preset = 'today';
      from = to = today;
      break;
  }

  // Typed backwards. Reading it the way it was clearly meant beats showing
  // an empty table and letting the person work out why.
  if (from && to && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  return {
    preset,
    from,
    to,
    start: from ? dayRange(from).start : null,
    end: to ? dayRange(to).end : null,
    isAll: !from && !to,
    isSingleDay: Boolean(from && to && from === to),
    days: from && to ? Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000) + 1 : null,
    label: rangeLabel(from, to),
  };
}

/** '2026-08-01', '2026-08-14' -> '1–14 Aug 2026'. Reads like a person wrote it. */
function rangeLabel(from, to) {
  if (!from && !to) return 'All time';

  const parts = (key) => {
    const d = new Date(`${key}T12:00:00Z`);
    return {
      day: d.getUTCDate(),
      month: d.toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'short' }),
      year: d.getUTCFullYear(),
    };
  };

  if (!from) { const t = parts(to); return `Up to ${t.day} ${t.month} ${t.year}`; }
  if (!to) { const f = parts(from); return `From ${f.day} ${f.month} ${f.year}`; }

  const f = parts(from);
  const t = parts(to);
  if (from === to) return `${f.day} ${f.month} ${f.year}`;
  if (f.year === t.year && f.month === t.month) return `${f.day}–${t.day} ${t.month} ${t.year}`;
  if (f.year === t.year) return `${f.day} ${f.month} – ${t.day} ${t.month} ${t.year}`;
  return `${f.day} ${f.month} ${f.year} – ${t.day} ${t.month} ${t.year}`;
}

/**
 * The `{ field: { $gte, $lt } }` clause for a range, or `{}` for all time.
 * Returned as a clause to merge rather than applied here, so a caller can
 * still express something more specific — the overlap rule the usage log
 * needs, for instance, which is not a plain "started between" test.
 */
function rangeClause(field, range) {
  if (!range || range.isAll) return {};
  const bounds = {};
  if (range.start) bounds.$gte = range.start;
  if (range.end) bounds.$lt = range.end;
  return { [field]: bounds };
}

/**
 * Step a range backwards or forwards by its own length, for the ‹ › buttons.
 * A single day moves a day, a week moves a week. Returns null for all time,
 * which has nothing to step through.
 */
function shiftRange(range, direction) {
  if (!range || range.isAll || !range.from || !range.to) return null;
  const span = range.days;
  return {
    from: shiftDay(range.from, span * direction),
    to: shiftDay(range.to, span * direction),
  };
}

/**
 * Rebuilds a query string with the range swapped out and everything else
 * left alone, so stepping through periods does not quietly drop the staff or
 * status the person had chosen.
 */
function rangeQuery(query, range, extra = {}) {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (['range', 'from', 'to', 'date', 'message'].includes(key)) return;
    if (value) params.set(key, value);
  });
  if (range) {
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    if (!range.from && !range.to) params.set('range', 'all');
  }
  Object.entries(extra).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * A case-insensitive "contains" pattern built safely from whatever somebody
 * typed into a search box.
 *
 * Every character with a meaning in a regex is escaped first. Without this,
 * searching for an asset tag with a bracket in it, or a lone "(", throws
 * while building the pattern and the page 500s — and a pattern assembled
 * from raw input is a pattern the person typing controls.
 *
 * Returns null for an empty search, so callers can skip the clause entirely.
 */
function searchRegex(term) {
  const text = String(term == null ? '' : term).trim();
  if (!text) return null;
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/* ---- Due dates and overdue items ---------------------------------- *
 * One definition of "overdue", used by the staff screens, the admin
 * screens and the counts on both. Three separate ideas of when an item is
 * late would show three different numbers for the same question.
 */

/**
 * The default "return by" offered when somebody takes an item out: 6pm
 * today, or 6pm tomorrow if it is already past that.
 *
 * A default is offered rather than demanded because the alternative — a
 * required field on every request — makes the common case slower for the
 * sake of the rare one. It can always be changed before submitting.
 */
function defaultDueAt(now = new Date()) {
  const local = new Date(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now) + 'T00:00:00Z'
  );

  const sixPm = new Date(local.getTime() + 18 * 3600000);
  const asUtc = new Date(sixPm.getTime() - tzOffsetMinutes(now) * 60000);
  return asUtc > now ? asUtc : new Date(asUtc.getTime() + 86400000);
}

/** The studio timezone's offset from UTC, in minutes, right now. */
function tzOffsetMinutes(when = new Date()) {
  const asLocal = new Date(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(when).replace(' ', 'T') + 'Z'
  );
  return Math.round((asLocal - when) / 60000);
}

/**
 * Is this loan past its return time?
 *
 * Takes anything carrying `dueAt` — a product or a movement. A loan that has
 * been submitted is not counted: the holder has done their part and it is
 * the admin who is now sitting on it, so nagging them about it would be
 * blaming the wrong person.
 */
function isOverdue(row, now = new Date()) {
  if (!row || !row.dueAt) return false;
  if (row.returnedAt) return false;
  if (row.returnRequestedAt || row.submittedAt) return false;
  return new Date(row.dueAt) < now;
}

/** "2 hours", "3 days" — how far past the return time, for a nudge. */
function overdueBy(row, now = new Date()) {
  if (!isOverdue(row, now)) return null;
  return formatDuration(Math.round((now - new Date(row.dueAt)) / 60000));
}

/**
 * The mongo clause for "overdue right now", matching isOverdue exactly.
 * Kept beside it so the count on a badge and the rows behind it can never
 * disagree — which is the classic way a number like this loses trust.
 */
function overdueClause(now = new Date()) {
  return {
    dueAt: { $ne: null, $lt: now },
    assignedTo: { $ne: null },
    returnRequestedAt: null,
  };
}

// Telegram messages are sent with parse_mode HTML
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- Booking day keys ----------------------------------------------- *
 * A booking is for a whole day. Days are stored as 'YYYY-MM-DD' strings
 * in the configured timezone so comparisons are simple string equality.
 */

// The day a given instant falls on, in the configured timezone
function dateKeyOf(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date));
}

const todayKey = () => dateKeyOf(new Date());

/**
 * Parse a typed date: '2026-08-20', '20-08-2026' or '20/08/2026'.
 * Returns a 'YYYY-MM-DD' key, or null when it is not a real date.
 */
function parseDateKey(text) {
  const t = String(text || '').trim();
  let y, m, d;
  let match = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, y, m, d] = match;
  else {
    match = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) return null;
    [, d, m, y] = match;
  }
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const probe = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== key) return null;
  return key;
}

// '2026-08-20' -> 'Thu, 20 Aug'
function formatDay(key) {
  if (!key) return '—';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

module.exports = {
  TZ,
  formatWhen,
  formatTime,
  formatDuration,
  formatSince,
  dayRange,
  shiftDay,
  RANGE_PRESETS,
  resolveRange,
  rangeLabel,
  rangeClause,
  shiftRange,
  rangeQuery,
  searchRegex,
  defaultDueAt,
  isOverdue,
  overdueBy,
  overdueClause,
  escapeHtml,
  dateKeyOf,
  todayKey,
  parseDateKey,
  formatDay,
  monthKeyOf,
  currentMonthKey,
  monthRange,
  monthLabel,
  shiftMonth,
};
