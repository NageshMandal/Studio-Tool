/**
 * The date range resolver, checked as arithmetic rather than by clicking
 * around. Every filter that picks a period runs through resolveRange, so a
 * mistake here is a mistake on three pages at once.
 */
process.env.TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

const {
  defaultDueAt,
  isOverdue,
  overdueBy,
  overdueClause,
  searchRegex,
  resolveRange,
  rangeLabel,
  rangeClause,
  shiftRange,
  rangeQuery,
  todayKey,
  shiftDay,
  dayRange,
} = require('./utils/format');

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`
  );
};

const today = todayKey();

console.log('\n--- Presets ---');
check('nothing asked for falls back to the default', resolveRange({}).preset, 'today');
check('and a page may choose its own default', resolveRange({}, '30d').preset, '30d');
check('today is one day', [resolveRange({ range: 'today' }).from, resolveRange({ range: 'today' }).to], [today, today]);
check('yesterday is the day before', resolveRange({ range: 'yesterday' }).from, shiftDay(today, -1));
check('last 7 days includes today', resolveRange({ range: '7d' }).to, today);
check('last 7 days is 7 days, not 8', resolveRange({ range: '7d' }).days, 7);
check('last 30 days is 30 days', resolveRange({ range: '30d' }).days, 30);
check('this month starts on the 1st', resolveRange({ range: 'month' }).from, `${today.slice(0, 7)}-01`);
check('all time has no bounds', resolveRange({ range: 'all' }).isAll, true);
check('an unknown preset falls back rather than breaking', resolveRange({ range: 'nonsense' }).preset, 'today');

console.log('\n--- Custom from/to ---');
let r = resolveRange({ from: '2026-08-01', to: '2026-08-14' });
check('a custom range is custom', r.preset, 'custom');
check('it keeps both ends', [r.from, r.to], ['2026-08-01', '2026-08-14']);
check('and counts the days inclusively', r.days, 14);

check('only a start is open-ended', resolveRange({ from: '2026-08-01' }).to, null);
check('only an end is open at the front', resolveRange({ to: '2026-08-14' }).from, null);
// Clearing the boxes resets the filter; it does not silently load every
// movement ever recorded, which on an unbounded table is a trap
check('cleared boxes reset to the page default', resolveRange({ range: 'custom' }).preset, 'today');
check('and respect that page\'s own default', resolveRange({ range: 'custom' }, '30d').preset, '30d');
check('rubbish in the boxes resets too', resolveRange({ from: 'tomorrow' }).preset, 'today');
check('all time is only ever reached deliberately', resolveRange({ range: 'all' }).isAll, true);
check('a bad default cannot loop', resolveRange({ range: 'custom' }, 'custom').preset, 'today');

r = resolveRange({ from: '2026-08-14', to: '2026-08-01' });
check('typed backwards, it reads them the way they were meant', [r.from, r.to], ['2026-08-01', '2026-08-14']);

console.log('\n--- The preset button beats the boxes ---');
r = resolveRange({ range: '7d', from: '2020-01-01', to: '2020-01-31' });
check('because that is the button the person pressed', r.preset, '7d');

console.log('\n--- The old single-date links still work ---');
r = resolveRange({ date: '2026-08-09' });
check('a bookmarked ?date= resolves', [r.from, r.to], ['2026-08-09', '2026-08-09']);
check('and is a single day', r.isSingleDay, true);

console.log('\n--- Instants ---');
r = resolveRange({ from: '2026-08-01', to: '2026-08-01' });
check('a single day starts where dayRange says', +r.start, +dayRange('2026-08-01').start);
check('and ends where dayRange says', +r.end, +dayRange('2026-08-01').end);
check('the end is exclusive, so it is midnight after the last day', +r.end - +r.start, 86400000);

r = resolveRange({ from: '2026-08-01', to: '2026-08-03' });
check('three days is three days of milliseconds', +r.end - +r.start, 3 * 86400000);
check('the last day is fully included', +r.end, +dayRange('2026-08-03').end);

console.log('\n--- Labels ---');
check('one day', rangeLabel('2026-08-09', '2026-08-09'), '9 Aug 2026');
check('within a month', rangeLabel('2026-08-01', '2026-08-14'), '1–14 Aug 2026');
check('across months', rangeLabel('2026-07-28', '2026-08-03'), '28 Jul – 3 Aug 2026');
check('across years', rangeLabel('2025-12-28', '2026-01-03'), '28 Dec 2025 – 3 Jan 2026');
check('open end', rangeLabel('2026-08-01', null), 'From 1 Aug 2026');
check('open start', rangeLabel(null, '2026-08-01'), 'Up to 1 Aug 2026');
check('no bounds', rangeLabel(null, null), 'All time');

console.log('\n--- The mongo clause ---');
r = resolveRange({ from: '2026-08-01', to: '2026-08-03' });
check('bounds both ends', Object.keys(rangeClause('occupiedAt', r).occupiedAt), ['$gte', '$lt']);
check('all time adds no clause at all', rangeClause('occupiedAt', resolveRange({ range: 'all' })), {});
check('an open end only bounds the front', Object.keys(rangeClause('occupiedAt', resolveRange({ from: '2026-08-01' })).occupiedAt), ['$gte']);

console.log('\n--- Stepping ---');
r = resolveRange({ from: '2026-08-01', to: '2026-08-07' });
check('back moves a whole week', shiftRange(r, -1), { from: '2026-07-25', to: '2026-07-31' });
check('forward moves a whole week', shiftRange(r, 1), { from: '2026-08-08', to: '2026-08-14' });
check('a single day steps by a day', shiftRange(resolveRange({ from: '2026-08-01', to: '2026-08-01' }), -1), { from: '2026-07-31', to: '2026-07-31' });
check('steps are contiguous, with no day skipped or repeated', shiftRange(r, -1).to, shiftDay(r.from, -1));
check('all time has nothing to step through', shiftRange(resolveRange({ range: 'all' }), -1), null);

console.log('\n--- Stepping keeps the other filters ---');
check(
  'staff and status survive a step',
  rangeQuery({ staff: 'u1', status: 'out', from: '2026-08-01', to: '2026-08-07' }, { from: '2026-07-25', to: '2026-07-31' }),
  '?staff=u1&status=out&from=2026-07-25&to=2026-07-31'
);
check(
  'the old date parameter is not carried along',
  rangeQuery({ date: '2026-08-01', q: 'lens' }, { from: '2026-08-02', to: '2026-08-02' }),
  '?q=lens&from=2026-08-02&to=2026-08-02'
);
check('empty filters are not passed as empty strings', rangeQuery({ staff: '', status: '' }, { from: '2026-08-01', to: '2026-08-01' }), '?from=2026-08-01&to=2026-08-01');

console.log('\n--- Search patterns ---');
/**
 * Every search box in the app builds its pattern here. A regex assembled
 * from raw typing is one the person typing controls — and a single "(" in
 * any search box used to throw while building it and 500 the page.
 */
check('a plain word matches', searchRegex('mic').test('Boom Mic'), true);
check('and is case-insensitive', searchRegex('MIC').test('boom mic'), true);
check('an asset tag matches itself', searchRegex('PAT-0004').test('PAT-0004'), true);

check('a lone bracket does not throw', typeof searchRegex('(') === 'object', true);
check('and matches the character itself', searchRegex('(').test('a(b'), true);
check('an unbalanced group is harmless', searchRegex('a(b').test('xxa(bxx'), true);

check('regex characters are literal, not wildcards', searchRegex('.*').test('anything'), false);
check('but do match themselves', searchRegex('.*').test('a .* b'), true);
check('a dot is not "any character"', searchRegex('a.c').test('abc'), false);
check('and matches a real dot', searchRegex('a.c').test('xa.cx'), true);

check('an empty search is no search at all', searchRegex(''), null);
check('and so is whitespace', searchRegex('   '), null);
check('and so is nothing', searchRegex(undefined), null);

console.log('\n--- Overdue ---');
/**
 * One rule, used by the staff nudge, the admin badges and the counts on
 * both. Three ideas of "late" would put three different numbers on screen
 * for the same question.
 */
const hoursAgo = (n) => new Date(Date.now() - n * 3600000);
const hoursAhead = (n) => new Date(Date.now() + n * 3600000);

check('past its time and still held', isOverdue({ dueAt: hoursAgo(3), assignedTo: 'u1' }), true);
check('not yet due', isOverdue({ dueAt: hoursAhead(3), assignedTo: 'u1' }), false);
check('no due date means never overdue', isOverdue({ dueAt: null, assignedTo: 'u1' }), false);
check('already returned', isOverdue({ dueAt: hoursAgo(3), returnedAt: new Date() }), false);

// The holder has done their part; the wait is now the admin's
check('submitted, so the holder is not nagged',
  isOverdue({ dueAt: hoursAgo(3), returnRequestedAt: new Date() }), false);
check('the same on a movement row',
  isOverdue({ dueAt: hoursAgo(3), submittedAt: new Date() }), false);

check('how late it is, in words', overdueBy({ dueAt: hoursAgo(3), assignedTo: 'u1' }), '3h');
check('and nothing when it is not late', overdueBy({ dueAt: hoursAhead(3) }), null);

console.log('\n--- The badge count and the rows behind it agree ---');
const clause = overdueClause();
check('it only counts held items', clause.assignedTo.$ne, null);
check('only ones past their time', clause.dueAt.$lt instanceof Date, true);
check('and never a submitted one', clause.returnRequestedAt, null);

console.log('\n--- The default return time ---');
const due = defaultDueAt();
check('is always in the future', due > new Date(), true);
check('and within the next day and a half', due - new Date() < 36 * 3600000, true);

console.log(fails ? `\n${fails} check(s) failed` : '\nDATE RANGES BEHAVE CORRECTLY');
process.exit(fails ? 1 : 0);
