/**
 * The two-step return, checked as behaviour.
 *
 * The database is faked at the document level: products and logs are plain
 * objects with a save(), which is all occupancy.js actually uses.
 *
 * The sequence is what matters. Submitting is a request, not a handover:
 * the item stays signed out to the person who submitted it, and only an
 * admin accepting ends the loan. Both accounts of the item's condition have
 * to survive with times against them.
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
    submittedAt: null,
    submitRemark: null,
    returnedAt: null,
    durationMinutes: null,
    acceptRemark: null,
    acceptedBy: null,
    acceptCondition: null,
    note: null,
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
  returnRequestedAt: null,
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

  console.log('\n--- Step one: the holder asks to hand it back ---');
  const beforeSubmit = Date.now();
  let log = await occupancy.requestSubmission({ product, source: 'web', remark: 'Lens cap missing' });

  check('the item is STILL with them', String(product.assignedTo), 'u1');
  check('and still counted as assigned', product.status, 'assigned');
  check('but flagged as waiting on an admin', Boolean(product.returnRequestedAt), true);
  check('the loan is NOT closed', log.returnedAt, null);
  check('so it still reads as out', Boolean(log.returnedAt), false);
  check('their remark is on the record', log.submitRemark, 'Lens cap missing');
  check('the submission is timed', log.submittedAt.getTime() >= beforeSubmit, true);

  console.log('\n--- Nobody else can take it while it waits ---');
  let refused = null;
  try {
    await occupancy.occupyProduct({ product, user: priya, reason: 'Other shoot', source: 'web' });
  } catch (err) {
    refused = err.code;
  }
  check('taking it is refused, because it is still held', refused, 'ALREADY_OCCUPIED');
  check('and it is still the same person\u2019s', String(product.assignedTo), 'u1');

  console.log('\n--- Whoever was waiting is deferred, not lost ---');
  check('no booking was auto-assigned on submission', bookingAutoAssignCalls, 0);
  check('and no next-in-line claim was filled', claimCalls, 0);

  console.log('\n--- Step two: the admin accepts ---');
  await occupancy.acceptSubmission({
    product,
    log,
    acceptedBy: 'priya@office.com',
    remark: 'Cap replaced from spares',
  });
  check('only now does it leave them', product.assignedTo, null);
  check('the flag is cleared', product.returnRequestedAt, null);
  check('it is back on the shelf', product.status, 'available');
  check('and the loan is closed', Boolean(log.returnedAt), true);
  check('the admin\u2019s remark is kept too', log.acceptRemark, 'Cap replaced from spares');
  check('and who accepted it', log.acceptedBy, 'priya@office.com');
  check('both accounts survive on one row', [log.submitRemark, log.acceptRemark], ['Lens cap missing', 'Cap replaced from spares']);
  check('accepted no earlier than submitted', log.returnedAt >= log.submittedAt, true);

  console.log('\n--- The duration covers the wait, because it was still theirs ---');
  check('it is measured to acceptance, not to submission',
    log.durationMinutes === Math.max(0, Math.round((log.returnedAt - new Date(log.occupiedAt)) / 60000)), true);

  console.log('\n--- Only now does the queue move ---');
  check('the booking check ran on acceptance', bookingAutoAssignCalls, 1);
  check('and the next-in-line queue was looked at', claimCalls, 1);

  console.log('\n--- The admin can send a submission back ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.requestSubmission({ product, source: 'web', remark: 'NA' });
  await occupancy.declineSubmission({ product, log, decidedBy: 'admin', remark: 'Never arrived at the desk' });

  check('the item stays with the same person', String(product.assignedTo), 'u1');
  check('the request is undone', product.returnRequestedAt, null);
  check('the submission is cleared, so it leaves the queue', log.submittedAt, null);
  check('the loan is still open', log.returnedAt, null);
  check('and why it was sent back is recorded', log.note.includes('Never arrived at the desk'), true);
  check('nothing went back on the shelf', product.status, 'assigned');

  console.log('\n--- They can submit it again afterwards ---');
  log = await occupancy.requestSubmission({ product, source: 'web', remark: 'Handed over at reception this time' });
  check('the second submission is recorded', log.submitRemark, 'Handed over at reception this time');
  check('and it is back on the admin\u2019s queue', Boolean(product.returnRequestedAt), true);

  console.log('\n--- An item marked for repair does not rejoin the pool ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.requestSubmission({ product, source: 'web', remark: 'Screen cracked' });
  await occupancy.acceptSubmission({
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
    acceptRemark: 'Returned at the counter',
  });
  check('it goes straight back on the shelf', product.status, 'available');
  check('with nobody holding it', product.assignedTo, null);
  check('and is not left looking unchecked', Boolean(log.returnedAt), true);
  check('with the admin named', log.acceptedBy, 'admin@office.com');

  console.log('\n--- Remarks are bounded ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.requestSubmission({ product, source: 'web', remark: 'x'.repeat(400) });
  check('an over-long submit remark is trimmed, not rejected', log.submitRemark.length, 300);
  await occupancy.acceptSubmission({ product, log, acceptedBy: 'a', remark: 'y'.repeat(400) });
  check('and so is the accept remark', log.acceptRemark.length, 300);

  console.log('\n--- "NA" is a real answer ---');
  reset();
  product = newProduct();
  await occupancy.occupyProduct({ product, user: amit, reason: 'Shoot', source: 'web' });
  log = await occupancy.requestSubmission({ product, source: 'web', remark: 'NA' });
  check('it is stored as given', log.submitRemark, 'NA');
  check('and still leaves the item with them', String(product.assignedTo), 'u1');

  console.log(fails ? `\n${fails} check(s) failed` : '\nTWO-STEP RETURNS BEHAVE CORRECTLY');
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error('CHECK CRASHED:\n', err);
  process.exit(1);
});
