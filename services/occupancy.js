const UsageLog = require('../models/UsageLog');
const Booking = require('../models/Booking');
const { studioName } = require('./studios');
const { todayKey } = require('../utils/format');

/**
 * The single place where an item changes hands. Both the Telegram bot
 * and the admin panel go through here so the usage log never has gaps.
 */

// Someone picks an item up.
async function occupyProduct({ product, user, reason, source = 'telegram' }) {
  if (product.assignedTo) {
    const err = new Error('This item is already occupied');
    err.code = 'ALREADY_OCCUPIED';
    throw err;
  }
  if (product.condition === 'retired') {
    const err = new Error('This item is retired and cannot be taken out');
    err.code = 'RETIRED';
    throw err;
  }
  if (product.status === 'maintenance') {
    const err = new Error('This item is in maintenance');
    err.code = 'MAINTENANCE';
    throw err;
  }

  // A confirmed booking for today reserves the item for the person who booked
  // it. The admin panel can still hand it to anyone (source 'admin').
  if (source !== 'admin') {
    const booking = await Booking.findOne({
      product: product._id,
      bookedFor: todayKey(),
      status: 'confirmed',
    }).lean();
    if (booking && String(booking.user) !== String(user._id)) {
      const err = new Error(`Booked for ${booking.userName} today`);
      err.code = 'BOOKED_TODAY';
      err.bookedBy = booking.userName;
      throw err;
    }
  }

  const cleanReason = (reason || '').trim().slice(0, 120) || null;

  const occupiedAt = new Date();
  product.assignedTo = user._id;
  product.status = 'assigned';
  product.occupiedAt = occupiedAt;
  product.occupyReason = cleanReason;
  await product.save();

  // The studio is taken from the ITEM, not from the person. They are the
  // same in normal use, and when they somehow are not, the item's studio is
  // the one whose report this movement belongs in.
  return UsageLog.create({
    location: product.location,
    locationName: await studioName(product.location),
    product: product._id,
    productName: product.name,
    assetTag: product.assetTag,
    category: product.category,
    imageUrl: product.imageUrl || null,
    user: user._id,
    userName: user.name,
    occupiedAt,
    reason: cleanReason,
    source,
  });
}

/**
 * Handing an item back takes two steps, and this is why.
 *
 * The staff member asks to hand it back and says what state it is in. The
 * item STAYS WITH THEM — still assigned, still their responsibility — until
 * an admin looks at it and accepts, with a remark of their own. Only then
 * does the loan end and the item go back into circulation.
 *
 * Keeping it assigned in between is the whole point. An item that had left
 * the holder but not yet reached the shelf would belong to nobody: not on
 * anyone's list, not anyone's responsibility, and invisible if it went
 * missing in exactly the gap where losing things is easiest.
 *
 * Everything waiting on the item — a booking for today, the next-in-line
 * queue — runs on acceptance, so the queue still empties itself, just after
 * the check rather than before it.
 */

/** The open loan for an item, or null. */
function openLoanFor(product) {
  return UsageLog.findOne({ product: product._id, returnedAt: null }).sort({ occupiedAt: -1 });
}

/**
 * Step one: the holder asks to hand the item back.
 *
 * Nothing about who holds it changes here. The remark is required by the
 * caller rather than defaulted — an empty note silently saved as "nothing to
 * report" would be exactly the record this feature exists to prevent.
 */
async function requestSubmission({ product, source = 'telegram', remark }) {
  const submittedAt = new Date();

  const openLog = await openLoanFor(product);
  if (openLog) {
    openLog.submittedAt = submittedAt;
    openLog.submitRemark = remark ? String(remark).trim().slice(0, 300) : null;
    openLog.returnSource = source;
    await openLog.save();
  }

  // The item is still assigned and still 'assigned' — only flagged as
  // waiting on an admin
  product.returnRequestedAt = submittedAt;
  await product.save();

  return openLog;
}

/**
 * Puts an item back into circulation and lets whoever was waiting have it.
 * Called on acceptance, never on submission.
 */
async function restoreToShelf(product, { claims = true } = {}) {
  // A broken item goes to maintenance rather than straight back into the pool
  product.status = product.condition === 'needs-repair' ? 'maintenance' : 'available';
  await product.save();

  // A confirmed booking for TODAY beats the next-in-line queue: the item
  // goes straight to the booker (occupyProduct would block the claimant
  // anyway while a confirmed booking is live). Lazy require avoids a cycle.
  let handedToBooker = null;
  if (claims) {
    try {
      const { autoAssignForProductToday } = require('./bookingAutoAssign');
      handedToBooker = await autoAssignForProductToday(product);
    } catch (err) {
      console.error('Could not auto-assign returned item to booker:', err.message);
    }
    if (!handedToBooker) await fulfillNextClaim(product);
  }

  // Bookings that were waiting for this item to come back now go to
  // the admins for a confirm/cancel decision (lazy require avoids a cycle)
  try {
    const { activateHeldBookings } = require('./booking');
    await activateHeldBookings(product);
  } catch (err) {
    console.error('Could not activate held bookings:', err.message);
  }

  return handedToBooker;
}

/**
 * Step two: the admin accepts. This is the moment the loan ends, so the
 * duration covers the whole time the person was responsible for the item —
 * including the wait for an admin, because it was still theirs throughout.
 *
 * `condition` is optional and only applied when given, so accepting never
 * silently resets a condition an admin set elsewhere. Marking it as needing
 * repair sends it to maintenance instead of back into the pool.
 */
async function acceptSubmission({ product, log, acceptedBy, remark, condition, claims = true }) {
  const returnedAt = new Date();

  if (log) {
    log.returnedAt = returnedAt;
    log.durationMinutes = Math.max(
      0,
      Math.round((returnedAt - new Date(log.occupiedAt)) / 60000)
    );
    log.acceptRemark = remark ? String(remark).trim().slice(0, 300) : null;
    log.acceptedBy = acceptedBy || null;
    log.acceptCondition = condition || null;
    await log.save();
  }

  product.assignedTo = null;
  product.occupiedAt = null;
  product.occupyReason = null;
  product.returnRequestedAt = null;
  if (condition) product.condition = condition;

  await restoreToShelf(product, { claims });

  return log;
}

/**
 * The admin sends a submission back: the item was not actually handed over,
 * or something needs sorting out first.
 *
 * It stays exactly where it was — with the same person, on the same loan —
 * so nothing about who is responsible changes. Only the request is undone.
 */
async function declineSubmission({ product, log, decidedBy, remark }) {
  if (log) {
    log.submittedAt = null;
    const note = remark ? String(remark).trim().slice(0, 300) : null;
    log.note = [log.note, `Submission sent back by ${decidedBy || 'the admin'}${note ? `: ${note}` : ''}`]
      .filter(Boolean)
      .join(' · ');
    await log.save();
  }

  product.returnRequestedAt = null;
  await product.save();

  return log;
}

/**
 * The one-step return, for when the admin is the one doing it.
 *
 * The admin panel swapping an item's holder, or the system handing an item
 * to the next person in line, has no second party to wait for — the admin is
 * already looking at it. So both halves run at once, and the acceptance is
 * still recorded with whoever did it, rather than leaving a loan that looks
 * like it was never checked in.
 */
async function releaseProduct({
  product,
  source = 'telegram',
  note,
  claims = true,
  remark,
  acceptedBy,
  acceptRemark,
}) {
  const openLog = await openLoanFor(product);

  if (openLog) {
    openLog.returnSource = source;
    if (note) openLog.note = note;
    if (remark) {
      openLog.submittedAt = openLog.submittedAt || new Date();
      openLog.submitRemark = String(remark).trim().slice(0, 300);
    }
    await openLog.save();
  }

  await acceptSubmission({
    product,
    log: openLog,
    acceptedBy: acceptedBy || 'system',
    remark: acceptRemark || null,
    claims,
  });

  return openLog;
}

/**
 * After a return: if someone is next in line, hand the item straight to them
 * and tell them on Telegram. Failures never break the return itself — the
 * claimant is told what happened instead.
 */
async function fulfillNextClaim(product) {
  const NextClaim = require('../models/NextClaim');
  const User = require('../models/User');
  const { notifyUser } = require('../bot/notify');
  const { escapeHtml } = require('../utils/format');

  const claim = await NextClaim.findOne({ product: product._id, status: 'waiting' }).sort({
    createdAt: 1,
  });
  if (!claim) return null;

  const claimant = await User.findById(claim.user);
  if (!claimant || claimant.status !== 'active') {
    claim.status = 'expired';
    claim.decidedAt = new Date();
    claim.decisionNote = 'Claimant is no longer active';
    await claim.save();
    return null;
  }

  // The item may have gone to maintenance on return
  if (product.status !== 'available') {
    claim.status = 'expired';
    claim.decidedAt = new Date();
    claim.decisionNote = 'Item went to maintenance on return';
    await claim.save();
    if (claimant.telegramChatId) {
      notifyUser(
        claimant.telegramChatId,
        `⚠️ <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> was returned, but it went into <b>maintenance</b> — it could not be handed to you.`
      );
    }
    return null;
  }

  try {
    await occupyProduct({ product, user: claimant, reason: claim.reason, source: 'auto' });
  } catch (err) {
    claim.status = 'expired';
    claim.decidedAt = new Date();
    claim.decisionNote = err.message;
    await claim.save();
    if (claimant.telegramChatId) {
      notifyUser(
        claimant.telegramChatId,
        `⚠️ <b>${escapeHtml(product.name)}</b> was returned but could not be handed to you: ${escapeHtml(err.message)}.`
      );
    }
    return null;
  }

  claim.status = 'fulfilled';
  claim.decidedAt = new Date();
  await claim.save();

  if (claimant.telegramChatId) {
    notifyUser(
      claimant.telegramChatId,
      `⚡ <b>It is yours now!</b> <b>${escapeHtml(product.name)}</b> <code>${escapeHtml(product.assetTag)}</code> was released and handed straight to you.\n` +
        (claim.reason ? `📝 For: ${escapeHtml(claim.reason)}\n` : '') +
        `\nTap <b>Submit item</b> in /mine when you bring it back.`
    );
  }

  return claim;
}

// Used by the admin edit form, where the holder can be swapped in one save.
async function syncAssignment({ product, previousAssignee, nextAssigneeId, users, reason, source = 'admin' }) {
  const before = previousAssignee ? String(previousAssignee) : '';
  const after = nextAssigneeId ? String(nextAssigneeId) : '';
  if (before === after) return null;

  if (before) await releaseProduct({ product, source, claims: false });
  if (after) {
    const holder = users.find((u) => String(u._id) === after);
    if (holder) await occupyProduct({ product, user: holder, reason, source });
  }
  return true;
}

module.exports = {
  occupyProduct,
  requestSubmission,
  acceptSubmission,
  declineSubmission,
  releaseProduct,
  restoreToShelf,
  fulfillNextClaim,
  syncAssignment,
};