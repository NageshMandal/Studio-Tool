/**
 * The date range resolver, checked as arithmetic rather than by clicking
 * around. Every filter that picks a period runs through resolveRange, so a
 * mistake here is a mistake on three pages at once.
 */
process.env.TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

const {
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

console.log(fails ? `\n${fails} check(s) failed` : '\nDATE RANGES BEHAVE CORRECTLY');
process.exit(fails ? 1 : 0);
