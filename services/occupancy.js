const UsageLog = require('../models/UsageLog');

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

// Someone brings it back.
async function releaseProduct({ product, source = 'telegram', note }) {
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

  return openLog;
}

// Used by the admin edit form, where the holder can be swapped in one save.
async function syncAssignment({ product, previousAssignee, nextAssigneeId, users, reason, source = 'admin' }) {
  const before = previousAssignee ? String(previousAssignee) : '';
  const after = nextAssigneeId ? String(nextAssigneeId) : '';
  if (before === after) return null;

  if (before) await releaseProduct({ product, source });
  if (after) {
    const holder = users.find((u) => String(u._id) === after);
    if (holder) await occupyProduct({ product, user: holder, reason, source });
  }
  return true;
}

module.exports = { occupyProduct, releaseProduct, syncAssignment };
