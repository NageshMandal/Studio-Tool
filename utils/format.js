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
  escapeHtml,
  dateKeyOf,
  todayKey,
  parseDateKey,
  formatDay,
};
