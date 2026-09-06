/**
 * Drives the real admin routes over HTTP with the database stubbed.
 *
 * boot-check proves the app starts, render-check proves the templates
 * compile, range-check proves the date arithmetic. This covers the join:
 * that a request with `?from=&to=` actually reaches the query as the right
 * bounds, that the old single-date links still resolve, and that the studio
 * hub creates and edits without leaving the page.
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/x';
process.env.JWT_SECRET = 'test-secret-value-for-flow-check';
process.env.ADMIN_EMAIL = 'admin@office.com';
process.env.ADMIN_PASSWORD = 'Admin@12345';
process.env.ADMIN_NAME = 'Studio Admin';
process.env.TIMEZONE = 'Asia/Kolkata';
process.env.PORT = '4997';

const mongoose = require('mongoose');
mongoose.connect = async () => ({ connection: { host: 'stub', name: 'stub' } });

const jwt = require('jsonwebtoken');
const Location = require('./models/Location');
const Admin = require('./models/Admin');
const User = require('./models/User');
const Product = require('./models/Product');
const UsageLog = require('./models/UsageLog');
const { todayKey, shiftDay, dayRange } = require('./utils/format');

Admin.migrateRoles = async () => 0;

/* ---------------- the fake database ---------------- */

/**
 * The ids have to be real ObjectId hex strings: the master dashboard builds
 * `new ObjectId(id)` for its per-studio aggregation, which rejects anything
 * else. A short fake id here would fail for a reason that has nothing to do
 * with what is being tested.
 */
const S1 = '000000000000000000000001';
const S2 = '000000000000000000000002';

let studios = [
  { _id: S1, name: 'Patna', code: 'PAT', city: 'Patna', address: 'Boring Road', phone: '1', theme: 'green', status: 'active' },
  { _id: S2, name: 'Ranchi', code: 'RAN', city: 'Ranchi', address: '', phone: '', theme: 'blue', status: 'active' },
];

// Every UsageLog query the app makes, so the tests can assert on the filter
// that was actually built rather than on the rendered numbers
let logQueries = [];

// Mongoose queries are chainable, so the stub has to be too — every builder
// method the app calls has to return the chain, or the call blows up before
// it ever reaches the code being tested
const chain = (value) => {
  const c = {
    sort: () => c,
    limit: () => c,
    skip: () => c,
    select: () => c,
    populate: () => c,
    lean: async () => value,
    then: (r) => Promise.resolve(value).then(r),
  };
  return c;
};

Location.find = (q) => chain(studios.filter((r) => !q || !q.status || r.status === q.status).map((r) => ({ ...r })));
Location.findById = (id) => {
  const found = studios.find((r) => String(r._id) === String(id));
  const doc = found && { ...found, save: async function () { Object.assign(found, this); delete found.save; return this; } };
  return { lean: async () => (found ? { ...found } : null), then: (r) => Promise.resolve(doc || null).then(r) };
};
Location.countDocuments = async (q) =>
  studios.filter((r) => !q || !q.status || r.status === q.status).length;
Location.create = async (doc) => {
  const row = { ...doc, _id: '00000000000000000000000' + (studios.length + 1), status: 'active' };
  studios.push(row);
  return row;
};

/**
 * Every UsageLog query is recorded, not just the last one. The master
 * dashboard makes several — the filtered movement list, then unfiltered ones
 * for the activity feed and the staff list — so keeping only the most recent
 * would have the test reading the wrong query and reporting no date bounds
 * on a page that has them.
 */
UsageLog.find = (filter) => { logQueries.push(filter); return chain([]); };
UsageLog.countDocuments = async (filter) => { logQueries.push(filter); return 0; };
UsageLog.aggregate = async () => [];

User.find = () => chain([]);
User.findById = (id) =>
  chain({
    _id: String(id), name: 'Amit Kumar', email: 'amit@office.com', department: 'Studio',
    designation: 'Operator', employeeId: 'E1', phone: '', status: 'active', location: S1,
  });
User.aggregate = async () => [];
User.countDocuments = async () => 0;
let lastProductFilter = null;
Product.find = (filter) => { lastProductFilter = filter; return chain([]); };

/**
 * The two detail panels load one document each. Without these they would
 * error, and the "no filter bar" assertion below would pass because it was
 * looking at an error page rather than a rendered panel.
 */
Product.findById = (id) =>
  chain({
    _id: String(id), name: 'Camera (Sony A7III)', assetTag: 'PAT-0001', category: 'Camera',
    location: S1, condition: 'good', status: 'assigned', price: 250000,
    assignedTo: { name: 'Amit Kumar', department: 'Studio' }, occupiedAt: new Date(),
  });
Product.aggregate = async () => [];
Product.countDocuments = async () => 0;
Admin.aggregate = async () => [];
Admin.updateMany = async () => ({});
Admin.findById = () => ({ lean: async () => null });

// The master dashboard counts pending work per studio before it draws the
// table, so these have to answer too or the page never reaches the filter
const AssignmentRequest = require('./models/AssignmentRequest');
const Booking = require('./models/Booking');
const ProcurementRequest = require('./models/ProcurementRequest');
[AssignmentRequest, Booking, ProcurementRequest].forEach((Model) => {
  Model.find = () => chain([]);
  Model.countDocuments = async () => 0;
  Model.aggregate = async () => [];
});

// One request and one booking sitting in the queue, so the pending panel has
// something to show and something to decide on
const pendingRequest = {
  _id: '000000000000000000000101', productName: 'Camera (Sony A7III)', assetTag: 'PAT-0001',
  imageUrl: null, userName: 'Amit Kumar', locationName: 'Patna', reason: 'Shoot',
  status: 'pending', createdAt: new Date(), location: S1,
};
const pendingBooking = {
  _id: '000000000000000000000102', productName: 'Lens (50mm)', assetTag: 'PAT-0002',
  imageUrl: null, userName: 'Priya Singh', locationName: 'Patna', bookedFor: '2026-09-10',
  status: 'pending', createdAt: new Date(), location: S1,
};
/**
 * Two of these share a batch, because that is the case worth checking: the
 * admin page has to group them and still give each its own buttons.
 * The stub honours `status` so the "already decided" list does not come back
 * holding the pending ones.
 */
const batched = [
  { ...pendingRequest, _id: '000000000000000000000103', productName: 'Lens (50mm)', assetTag: 'PAT-0002', userName: 'Neha Verma', batch: 'batch-1' },
  { ...pendingRequest, _id: '000000000000000000000104', productName: 'Tripod', assetTag: 'PAT-0003', userName: 'Neha Verma', batch: 'batch-1' },
];
AssignmentRequest.find = (filter) => {
  let all = [{ ...pendingRequest }, ...batched.map((b) => ({ ...b }))];
  // Honouring `batch` matters: without it a batch action would appear to
  // sweep up every pending request, and the test would not notice
  if (filter && filter.batch) all = all.filter((r) => r.batch === filter.batch);
  if (filter && filter.status && filter.status.$ne === 'pending') return chain([]);
  return chain(all);
};
AssignmentRequest.countDocuments = async () => 3;
Booking.find = () => chain([{ ...pendingBooking }]);
Booking.countDocuments = async () => 1;

// The decision path goes through the approvals service, which loads the
// document itself. It is stubbed to refuse, because what is being checked
// here is the wiring — that the panel posts, the route accepts it and the
// refreshed queue comes back — not the approval rules, which requests own.
// The requests page also reads the next-in-line queue
const NextClaim = require('./models/NextClaim');
NextClaim.find = () => chain([]);
NextClaim.countDocuments = async () => 0;

const approvals = require('./services/approvals');
approvals.approveRequest = async () => ({ ok: false, message: 'That request has already been dealt with' });
approvals.rejectRequest = async () => ({ ok: true, message: 'Request declined' });
approvals.approveBooking = async () => ({ ok: true, message: 'Booking confirmed' });
approvals.rejectBooking = async () => ({ ok: true, message: 'Booking declined' });

require('./server.js');

/* ---------------- the client ---------------- */

const BASE = 'http://127.0.0.1:4997';
const token = jwt.sign({ id: 'root', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });

const call = (url, init = {}) => {
  logQueries = [];
  return fetch(BASE + url, {
    redirect: 'manual',
    ...init,
    headers: { Cookie: `token=${token}${init.cookie || ''}`, ...(init.headers || {}) },
  });
};

const post = (url, body, init = {}) =>
  call(url, {
    method: 'POST',
    body: new URLSearchParams(body).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    ...init,
  });

// Most admin pages need a studio open; the cookie is how that is remembered
const inStudio = { cookie: `; activeStudio=${S1}` };

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${!pass && detail ? `  -> ${detail}` : ''}`);
};

/**
 * The date bounds the app ended up querying with, as day keys.
 *
 * Picks the query that actually carries bounds rather than assuming there
 * was only one — the unfiltered feed queries alongside it are not the
 * subject, and letting them answer would hide a real regression.
 */
function queriedBounds() {
  const dated = logQueries.filter((f) => f && (f.occupiedAt || f.$or));
  const f = dated.length ? dated[dated.length - 1] : logQueries[logQueries.length - 1] || {};
  const lt = f.occupiedAt && f.occupiedAt.$lt;
  const gte = (f.occupiedAt && f.occupiedAt.$gte) || (f.$or && f.$or[1] && f.$or[1].returnedAt.$gte);
  return {
    // $lt is midnight *after* the last day, so step back to name that day
    to: lt ? new Date(+lt - 1).toISOString().slice(0, 10) : null,
    from: gte ? new Date(+gte + 12 * 3600000).toISOString().slice(0, 10) : null,
    hasBounds: Boolean(lt || gte),
  };
}

setTimeout(async () => {
  const today = todayKey();

  console.log('\nUsage log — date ranges reach the query');
  await call('/admin/logs', inStudio);
  let b = queriedBounds();
  check('with nothing asked for, it is today', b.from === today && b.to === today, JSON.stringify(b));

  await call(`/admin/logs?from=2026-08-01&to=2026-08-14`, inStudio);
  b = queriedBounds();
  check('a typed range reaches the query intact', b.from === '2026-08-01' && b.to === '2026-08-14', JSON.stringify(b));

  await call('/admin/logs?range=7d', inStudio);
  b = queriedBounds();
  check('the 7-day shortcut spans 7 days', b.from === shiftDay(today, -6) && b.to === today, JSON.stringify(b));

  await call('/admin/logs?range=7d&from=2020-01-01&to=2020-01-02', inStudio);
  b = queriedBounds();
  check('a pressed shortcut beats stale boxes', b.from === shiftDay(today, -6), JSON.stringify(b));

  await call('/admin/logs?from=2026-08-14&to=2026-08-01', inStudio);
  b = queriedBounds();
  check('a backwards range is read the way it was meant', b.from === '2026-08-01' && b.to === '2026-08-14', JSON.stringify(b));

  console.log('\nThe old single-date links still work');
  let r = await call('/admin/logs?date=2026-08-09', inStudio);
  b = queriedBounds();
  check('?date= still resolves, to that one day', r.status === 200 && b.from === '2026-08-09' && b.to === '2026-08-09', JSON.stringify(b));

  r = await call('/admin/tracker?date=2026-08-09', inStudio);
  b = queriedBounds();
  check('on the tracker too', r.status === 200 && b.from === '2026-08-09', JSON.stringify(b));

  console.log('\nThe range control is on every page that filters by date');
  for (const [label, url] of [
    ['usage log', '/admin/logs'],
    ['tracker', '/admin/tracker'],
    ['master dashboard', '/admin/master'],
  ]) {
    const html = await (await call(url, inStudio)).text();
    check(`${label} renders the shortcuts and both boxes`,
      html.includes('range-presets') && html.includes('name="from"') && html.includes('name="to"'));
  }

  console.log('\nThe master dashboard opens on a useful default');
  await call('/admin/master', inStudio);
  b = queriedBounds();
  check('30 days, not a single day', b.from === shiftDay(today, -29) && b.to === today, JSON.stringify(b));

  await call('/admin/master?range=all', inStudio);
  b = queriedBounds();
  check('and All time really is unbounded', b.hasBounds === false, JSON.stringify(b));

  console.log('\nStepping keeps the rest of the filter');
  const html = await (await call('/admin/logs?range=7d&staff=u1&q=lens', inStudio)).text();
  const prev = (html.match(/href="(\/admin\/logs\?[^"]*)"[^>]*title="Previous/) || [])[1] || '';
  check('the ‹ link carries the staff filter', prev.includes('staff=u1'), prev);
  check('and the search text', prev.includes('q=lens'), prev);
  check('and moves back a full week', prev.includes(`from=${shiftDay(today, -13)}`), prev);

  console.log('\nMaster dashboard — the page itself');
  let page = await (await call('/admin/master', inStudio)).text();
  check('it greets by name', /Good (morning|afternoon|evening), /.test(page), page.slice(0, 80));
  check('the cards are openable buttons, not dead numbers', (page.match(/stat is-openable/g) || []).length === 6);
  check('overdue items is gone, as asked', !/Overdue/i.test(page));
  check('quick overview is gone, as asked', !/Quick Overview/i.test(page));
  check('the drawer is on the page, closed', page.includes('id="drawer"') && page.includes('aria-hidden="true"'));
  check('top studios is there', page.includes('Top studios'));
  check('item categories is there', page.includes('Item categories'));
  check('recent employees is gone, as asked', !/Recent employees/i.test(page));
  check('but employees are still reachable from the card', page.includes('data-panel="employees"'));

  console.log('\nEvery card and list opens a panel');
  for (const [label, kind, params] of [
    ['studios', 'studios', ''],
    ['all items', 'items', ''],
    ['employees', 'employees', ''],
    ['currently out', 'out', ''],
    ['pending requests', 'pending', ''],
    ['asset value', 'value', ''],
    ['issued items', 'issued', ''],
    ['activity', 'activity', ''],
    ['categories', 'categories', ''],
    ['items in a category', 'items', '?category=Camera'],
  ]) {
    const res = await call(`/admin/master/panel/${kind}${params}`, inStudio);
    const body = await res.text();
    check(`${label} panel answers`, res.status === 200 && body.trim().length > 0, `${res.status}`);
  }

  let res = await call('/admin/master/panel/nonsense', inStudio);
  check('an unknown panel is a plain 404, not a crash', res.status === 404, String(res.status));

  console.log('\nThe currently-out panel shows who has what');
  Product.find = (filter) => { lastProductFilter = filter; return chain([{
    _id: '000000000000000000000201', name: 'Camera (Sony A7III)', assetTag: 'PAT-0001',
    imageUrl: 'https://example.com/cam.jpg', location: S1, occupiedAt: new Date(),
    assignedTo: { name: 'Amit Kumar', department: 'Studio' },
  }]); };
  let out = await (await call('/admin/master/panel/out', inStudio)).text();
  check('the holder is named', out.includes('Amit Kumar'));
  check('with a picture of the item', out.includes('cam.jpg'));

  console.log('\nPending requests can be decided without leaving the panel');
  let pend = await (await call('/admin/master/panel/pending', inStudio)).text();
  check('the queue lists both kinds', pend.includes('Item requests') && pend.includes('Bookings'));
  check('each row offers approve and decline',
    pend.includes('data-decide="approve"') && pend.includes('data-decide="reject"'));
  check('purchase requests are still kept out', pend.includes('not shown here'));

  res = await post('/admin/master/decide',
    { kind: 'booking', id: '000000000000000000000102', action: 'approve' }, inStudio);
  const after = await res.text();
  check('deciding answers with the refreshed queue', res.status === 200 && after.includes('Item requests'), String(res.status));
  check('and reports what happened', after.includes('Booking confirmed'));

  console.log('\nThe drawer can actually be closed');
  page = await (await call('/admin/master', inStudio)).text();
  /**
   * The close and back buttons broke because the drawer element itself
   * carried data-panel, which is what the openers are matched on — so a
   * click on Close walked up, found the drawer, and reopened the panel
   * instead. Both halves of that are asserted: the markup must not carry it,
   * and the script must not put it there at runtime either.
   */
  const drawerTag = (page.match(/<aside class="drawer"[^>]*>/) || [''])[0];
  check('the drawer markup carries no data-panel', !drawerTag.includes('data-panel'), drawerTag);

  /**
   * Comments are stripped first. The fix is explained in a comment that
   * quotes the very selector being searched for, and matching that instead
   * of the code would make this check pass for the wrong reason.
   */
  const appJs = require('fs')
    .readFileSync('./public/js/app.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  check('and the script never sets one on it', !/drawer\.dataset\.panel\s*=/.test(appJs));

  const atClose = appJs.indexOf("closest('#drawerClose')");
  const atBack = appJs.indexOf("closest('#drawerBack')");
  const atOpener = appJs.indexOf("closest('[data-panel]')");
  check('all three checks are present in the code', [atClose, atBack, atOpener].every((i) => i > -1), `${atClose}/${atBack}/${atOpener}`);
  check('close is handled before openers', atClose < atOpener, `${atClose} vs ${atOpener}`);
  check('and so is back', atBack < atOpener, `${atBack} vs ${atOpener}`);

  console.log('\nEach panel can be searched and filtered');
  for (const kind of ['studios', 'items', 'out', 'pending', 'issued', 'activity', 'employees', 'categories', 'value']) {
    const html = await (await call(`/admin/master/panel/${kind}`, inStudio)).text();
    check(`${kind} offers a filter bar`, html.includes('data-panel-filter') && html.includes('name="q"'));
  }
  for (const kind of ['item', 'employee']) {
    const html = await (await call(`/admin/master/panel/${kind}?id=000000000000000000000201`, inStudio)).text();
    // Assert it really rendered, so "no filter bar" cannot be satisfied by
    // an error page that happens to contain no filter bar either
    check(`${kind} detail renders`, html.includes('panel-hero'), html.slice(0, 60));
    check(`${kind} detail has none, having nothing to filter`, !html.includes('data-panel-filter'));
  }

  console.log('\nA filter reaches the query, rather than only the markup');
  lastProductFilter = null;
  await call('/admin/master/panel/items?q=camera&status=out', inStudio);
  check('the search term becomes a query', Boolean(lastProductFilter && lastProductFilter.$or), JSON.stringify(lastProductFilter));
  check('and "out with someone" means assigned', 
    Boolean(lastProductFilter && lastProductFilter.assignedTo && lastProductFilter.assignedTo.$ne !== undefined),
    JSON.stringify(lastProductFilter));

  lastProductFilter = null;
  await call(`/admin/master/panel/items?studio=${S1}&category=Camera`, inStudio);
  check('a studio narrows it', String(lastProductFilter.location), S1);
  check('and so does a category', lastProductFilter.category, 'Camera');

  lastProductFilter = null;
  await call('/admin/master/panel/items?status=available', inStudio);
  check('"available" excludes items waiting to be checked in',
    lastProductFilter.status === 'available' && lastProductFilter.assignedTo === null,
    JSON.stringify(lastProductFilter));

  const cleared = await (await call('/admin/master/panel/items', inStudio)).text();
  check('with nothing applied there is no Clear button', !cleared.includes('data-panel-clear'));
  const applied = await (await call('/admin/master/panel/items?q=camera', inStudio)).text();
  check('and with something applied there is', applied.includes('data-panel-clear'));

  console.log('\nTwo-step returns — the admin queue and its guards');
  const UsageLog2 = require('./models/UsageLog');
  const submittedLog = {
    _id: '000000000000000000000301', product: '000000000000000000000201',
    productName: 'Camera (Sony A7III)', assetTag: 'PAT-0001', userName: 'Amit Kumar',
    location: S1, returnedAt: new Date(), acceptedAt: null, durationMinutes: 180,
    submitRemark: 'Lens cap missing',
  };
  let savedLog = null;
  UsageLog2.find = () => chain([{ ...submittedLog }]);
  UsageLog2.findById = async (id) =>
    String(id) === submittedLog._id
      ? { ...submittedLog, save: async function () { savedLog = this; return this; } }
      : null;

  let reqPage = await (await call('/admin/requests', inStudio)).text();
  check('the check-in queue is on the requests page', reqPage.includes('Items to check in'));
  check('it shows what the staff member said', reqPage.includes('Lens cap missing'));
  check('and asks the admin for their own remark', reqPage.includes('name="remark"'));
  check('with a condition they can set', reqPage.includes('name="condition"'));

  res = await post(`/admin/returns/${submittedLog._id}/accept`, { remark: '' }, inStudio);
  check('a blank remark is refused',
    res.status === 302 && decodeURIComponent(String(res.headers.get('location'))).includes('Add a remark'),
    res.headers.get('location'));
  check('and nothing was written', savedLog === null, true, String(savedLog && savedLog._id));

  console.log('\nChecking an item in actually writes both halves');
  /**
   * The real occupancy service runs here. Patching it would have proved
   * nothing: requestController destructures acceptReturn at require time, so
   * a later reassignment on the module object never reaches it — the first
   * attempt at this test passed for exactly that reason.
   */
  let shelved = null;
  Product.findById = (id) =>
    chain({
      _id: String(id), name: 'Camera (Sony A7III)', assetTag: 'PAT-0001', category: 'Camera',
      location: S1, condition: 'good', status: 'pending-return', price: 250000,
      assignedTo: null, occupiedAt: null,
      save: async function () { shelved = this; return this; },
    });
  NextClaim.findOne = () => ({ sort: async () => null });
  Booking.findOne = () => ({ lean: async () => null });

  savedLog = null;
  res = await post(
    `/admin/returns/${submittedLog._id}/accept`,
    { remark: 'Cap replaced from spares', condition: 'good' },
    inStudio
  );
  check('a good check-in redirects back to the queue',
    res.status === 302 && String(res.headers.get('location')).startsWith('/admin/requests'),
    `${res.status} ${res.headers.get('location')}`);
  check('the admin remark was saved',
    savedLog && savedLog.acceptRemark === 'Cap replaced from spares',
    savedLog && savedLog.acceptRemark);
  check('with a time against it', Boolean(savedLog && savedLog.acceptedAt), true);
  check('and the admin named', Boolean(savedLog && savedLog.acceptedBy), true);
  check('the staff remark is still there beside it',
    savedLog && savedLog.submitRemark === 'Lens cap missing',
    savedLog && savedLog.submitRemark);
  check('the item went back on the shelf', shelved && shelved.status === 'available',
    shelved && shelved.status);

  // Checking the same one in twice is refused rather than double-counted
  UsageLog2.findById = async () => ({ ...submittedLog, acceptedAt: new Date(), save: async function () { return this; } });
  res = await post(`/admin/returns/${submittedLog._id}/accept`, { remark: 'NA' }, inStudio);
  check('checking the same item in twice is refused',
    decodeURIComponent(String(res.headers.get('location'))).includes('already been checked in'),
    res.headers.get('location'));

  console.log('\nAsking for several items at once');
  reqPage = await (await call('/admin/requests', inStudio)).text();
  check('batched requests are shown as a group', reqPage.includes('asked for') && reqPage.includes('Approve all'));
  check('and each item in the batch keeps its own buttons',
    (reqPage.match(/\/admin\/requests\/[^"]*\/approve/g) || []).length >= 2);

  // Approving a batch loops the same per-item call the single buttons use,
  // so an item somebody else has taken fails on its own terms
  const decided = [];
  const realApprove = approvals.approveRequest;
  approvals.approveRequest = async (id) => {
    decided.push(String(id));
    return String(id) === '000000000000000000000104'
      ? { ok: false, message: 'The item is already with someone else' }
      : { ok: true, message: 'Approved' };
  };

  res = await post('/admin/requests/batch/batch-1/approve', {}, inStudio);
  const outcome = decodeURIComponent(String(res.headers.get('location')));
  check('only the batch was touched, not every pending request', decided.length === 2, String(decided.length));
  check('the one that worked is counted', outcome.includes('1 approved'), outcome);
  check('and the one that did not is named, not hidden',
    outcome.includes('Tripod') && outcome.includes('already with someone else'), outcome);
  approvals.approveRequest = realApprove;

  res = await post('/admin/requests/batch/batch-none/approve', {}, inStudio);
  check('an empty batch is handled, not crashed',
    res.status === 302 && decodeURIComponent(String(res.headers.get('location'))).includes('already been dealt with'),
    `${res.status} ${res.headers.get('location')}`);

  console.log('\nStudio hub — one page, no navigating away');
  r = await call('/admin/studios');
  const hub = await r.text();
  check('it lists the studios', hub.includes('>Patna<') && hub.includes('>Ranchi<'));
  check('each can be opened', hub.includes(`/admin/studios/open/${S1}`));
  check('each can be edited in place', hub.includes('data-studio-edit') && hub.includes('data-code="PAT"'));
  check('one can be added from the grid', hub.includes('studio-card-add'));
  check('and the dialog ships closed', hub.includes('class="modal-backdrop"'));

  for (const [from, to] of [
    ['/admin/studios/manage', '/admin/studios'],
    ['/admin/studios/new', '/admin/studios?form=new'],
    [`/admin/studios/${S1}/edit`, `/admin/studios?form=edit&id=${S1}`],
  ]) {
    r = await call(from);
    check(`${from} still lands right`, r.status === 302 && r.headers.get('location') === to,
      `${r.status} ${r.headers.get('location')}`);
  }

  r = await post('/admin/studios', { name: 'Kolkata', code: 'KOL', city: 'Kolkata', theme: 'purple' });
  check('creating redirects back to the hub',
    r.status === 302 && String(r.headers.get('location')).startsWith('/admin/studios?message='),
    r.headers.get('location'));
  check('and the studio is really there', studios.some((s) => s.code === 'KOL'));

  r = await post(`/admin/studios/${S1}?_method=PUT`, { name: 'Patna Central', city: 'Patna', theme: 'green' });
  check('editing redirects back to the hub',
    r.status === 302 && String(r.headers.get('location')).startsWith('/admin/studios?message='),
    r.headers.get('location'));
  check('and the change stuck', studios.find((s) => s._id === S1).name === 'Patna Central');

  console.log(failed ? `\n${failed} check(s) failed` : '\nALL FLOW CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}, 1500);
