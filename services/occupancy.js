const UsageLog = require('../models/UsageLog');
const Booking = require('../models/Booking');
const { todayKey } = require('../utils/format');

/**
 * The single place where an instrument changes hands. Both the Telegram bot
 * and the admin panel go through here so the usage log never has gaps.
 */

// Someone picks an instrument up.
async function occupyProduct({ product, user, reason, source = 'telegram' }) {
  if (product.assignedTo) {
    const err = new Error('This instrument is already occupied');
    err.code = 'ALREADY_OCCUPIED';
    throw err;
  }
  if (product.condition === 'retired') {
    const err = new Error('This instrument is retired and cannot be taken out');
    err.code = 'RETIRED';
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

  return UsageLog.create({
    product: product._id,
    productName: product.name,
    assetTag: product.assetTag,
    imageUrl: product.imageUrl || null,
    user: user._id,
    userName: user.name,
    occupiedAt,
    reason: cleanReason,
    source,
  });
}

// Someone brings it back. When a next-in-line claim is waiting, the item is
// handed straight to the claimant instead of going back on the shelf
// (pass claims: false to skip that, e.g. when the admin form swaps holders).
async function releaseProduct({ product, source = 'telegram', note, claims = true }) {
  const returnedAt = new Date();

  const openLog = await UsageLog.findOne({
    product: product._id,
    returnedAt: null,
  }).sort({ occupiedAt: -1 });

  if (openLog) {
    openLog.returnedAt = returnedAt;
    openLog.durationMinutes = Math.max(
      0,
      Math.round((returnedAt - new Date(openLog.occupiedAt)) / 60000)
    );
    openLog.returnSource = source;
    if (note) openLog.note = note;
    await openLog.save();
  }

  product.assignedTo = null;
  product.occupiedAt = null;
  product.occupyReason = null;
  // A broken item goes to maintenance rather than straight back into the pool
  product.status = product.condition === 'needs-repair' ? 'maintenance' : 'available';
  await product.save();

  if (claims) await fulfillNextClaim(product);

  // Bookings that were waiting for this instrument to come back now go to
  // the admins for a confirm/cancel decision (lazy require avoids a cycle)
  try {
    const { activateHeldBookings } = require('./booking');
    await activateHeldBookings(product);
  } catch (err) {
    console.error('Could not activate held bookings:', err.message);
  }

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

module.exports = { occupyProduct, releaseProduct, syncAssignment, fulfillNextClaim };
