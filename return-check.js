/**
 * The two-step return and multi-item requests, checked as behaviour.
 *
 * The database is faked at the document level: products and logs are plain
 * objects with a save(), which is all occupancy.js actually uses. What is
 * being asserted is the sequence — that an item does not go back on the
 * shelf until an admin has looked at it, and that both accounts of its
 * condition survive with times against them.
 */
process.env.TIMEZONE = 'Asia/Kolkata';

const path = require('path');
const Module = require('module');

/* ---------------- a fake database, injected before occupancy loads ---- */

let logs = [];
let bookingAutoAssignCalls = 0;
let claimCalls = 0;

// Mirrors the schema's defaults, so an assertion about "nothing has accepted
// this yet" is testing the code rather than the gap in a hand-made object
const makeLog = (fields) => {
  const log = {
    returnedAt: null,
    durationMinutes: null,
    submitRemark: null,
    acceptedAt: null,
    acceptRemark: null,
    acceptedBy: null,
    acceptCondition: null,
    ...fields,
    save: async function () {
      return this;
    },
  };
  logs.push(log);
  return log;
};

const UsageLogStub = {
  findOne(filter) {
    const match = logs.find(
      (l) => String(l.product) === String(filter.product) && l.returnedAt == null
    );
    return { sort: () => Promise.resolve(match || null) };
  },
  create: async (doc) => makeLog(doc),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../models/UsageLog') return UsageLogStub;
  if (request === '../models/Booking') return { findOne: () => ({ lean: async () => null }) };
  if (request === './studios') return { studioName: async () => 'Patna' };
  if (request === './bookingAutoAssign') {
    return {
      autoAssignForProductToday: async () => {
        bookingAutoAssignCalls++;
        return null;
      },
    };
  }
  if (request === './booking') return { activateHeldBookings: async () => {} };
  if (request === '../models/NextClaim') {
    return { findOne: () => ({ sort: async () => { claimCalls++; return null; } }) };
  }
  if (request === '../models/User') return { findById: async () => null };
  if (request === '../bot/notify') return { notifyUser: () => {}, notifyLocationAdmins: () => {} };
  return originalLoad.apply(this, arguments);
};

/**
 * The patch stays in place for the whole run. occupancy.js requires
 * bookingAutoAssign, NextClaim and booking lazily, inside the functions that
 * use them, to avoid a require cycle — so restoring the loader after the
 * first require would let the real modules through the moment a return was
 * accepted, and they would go looking for a database.
 */
const occupancy = require(path.join(__dirname, 'services/occupancy.js'));

/* ---------------- helpers ---------------- */

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`
  );
};

const newProduct = (over = {}) => ({
  _id: 'p1',
  name: 'Camera',
  assetTag: 'PAT-0001',
  category: 'Camera',
  location: 'loc1',
  condition: 'good',
  status: 'available',
  assignedTo: null,
  occupiedAt: null,
  save: async function () { return this; },
  ...over,
});

const amit = { _id: 'u1', name: 'Amit' };
const priya = { _id: 'u2', name: 'Priya' };

const reset = () => {
  logs = [];
  bookingAutoAssignCalls = 0;
  claimCalls = 0;
};

(async () => {
  console.log('\n--- Taking an item out is unchanged ---');
  reset();
  let product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  check('it is with them', String(product.assignedTo), 'u1');
  check('and marked assigned', product.status, 'assigned');
  check('with an open movement on the log', logs.length, 1);

  console.log('\n--- Step one: the staff member hands it back ---');
  const beforeSubmit = Date.now();
  let log = await occupancy.submitProduct({ product, source: 'web', remark: 'Lens cap missing' });
  check('nobody is holding it', product.assignedTo, null);
  check('but it is NOT back on the shelf', product.status, 'pending-return');
  check('the loan is closed', Boolean(log.returnedAt), true);
  check('their remark is on the record', log.submitRemark, 'Lens cap missing');
  check('nobody has accepted it yet', log.acceptedAt, null);
  check('the submission is timed', log.returnedAt.getTime() >= beforeSubmit, true);

  console.log('\n--- Nobody can take it while it waits ---');
  let refused = null;
  try {
    await occupancy.occupyProduct({ product, user: priya, reason: 'Other shoot', source: 'web' });
  } catch (err) {
    refused = err.code;
  }
  check('taking it is refused', refused, 'PENDING_RETURN');
  check('and it is still nobody\u2019s', product.assignedTo, null);

  console.log('\n--- Whoever was waiting is deferred, not lost ---');
  check('no booking was auto-assigned on submission', bookingAutoAssignCalls, 0);
  check('and no next-in-line claim was filled', claimCalls, 0);

  console.log('\n--- Step two: the admin checks it in ---');
  await occupancy.acceptReturn({
    product,
    log,
    acceptedBy: 'priya@office.com',
    remark: 'Cap replaced from spares',
  });
  check('it is back on the shelf', product.status, 'available');
  check('the acceptance is timed', Boolean(log.acceptedAt), true);
  check('the admin\u2019s remark is kept too', log.acceptRemark, 'Cap replaced from spares');
  check('and who accepted it', log.acceptedBy, 'priya@office.com');
  check('both accounts survive on one row', [log.submitRemark, log.acceptRemark], ['Lens cap missing', 'Cap replaced from spares']);
  check('accepted no earlier than submitted', log.acceptedAt >= log.returnedAt, true);

  console.log('\n--- Only now does the queue move ---');
  check('the booking check ran on acceptance', bookingAutoAssignCalls, 1);
  check('and the next-in-line queue was looked at', claimCalls, 1);

  console.log('\n--- An item marked for repair does not rejoin the pool ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.submitProduct({ product, source: 'web', remark: 'Screen cracked' });
  await occupancy.acceptReturn({
    product,
    log,
    acceptedBy: 'admin',
    remark: 'Confirmed cracked, sending for repair',
    condition: 'needs-repair',
  });
  check('the condition the admin recorded sticks', product.condition, 'needs-repair');
  check('and it goes to maintenance, not the shelf', product.status, 'maintenance');
  check('what they changed it to is on the record', log.acceptCondition, 'needs-repair');

  let blocked = null;
  try {
    await occupancy.occupyProduct({ product, user: priya, reason: 'Shoot', source: 'web' });
  } catch (err) {
    blocked = err.code;
  }
  check('and it cannot be taken out', blocked, 'MAINTENANCE');

  console.log('\n--- The admin\u2019s own one-step return still works ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.releaseProduct({
    product,
    source: 'admin',
    acceptedBy: 'admin@office.com',
    acceptRemark: 'Checked in at the counter',
  });
  check('it goes straight back on the shelf', product.status, 'available');
  check('and is not left looking unchecked', Boolean(log.acceptedAt), true);
  check('with the admin named', log.acceptedBy, 'admin@office.com');

  console.log('\n--- Remarks are bounded ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.submitProduct({ product, source: 'web', remark: 'x'.repeat(400) });
  check('an over-long submit remark is trimmed, not rejected', log.submitRemark.length, 300);
  await occupancy.acceptReturn({ product, log, acceptedBy: 'a', remark: 'y'.repeat(400) });
  check('and so is the accept remark', log.acceptRemark.length, 300);

  console.log('\n--- "NA" is a real answer ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.submitProduct({ product, source: 'web', remark: 'NA' });
  check('it is stored as given', log.submitRemark, 'NA');
  check('and still parks the item for a check', product.status, 'pending-return');

  console.log(fails ? `\n${fails} check(s) failed` : '\nTWO-STEP RETURNS BEHAVE CORRECTLY');
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error('CHECK CRASHED:\n', err);
  process.exit(1);
});
