const NextClaim = require('../models/NextClaim');
const Product = require('../models/Product');
const User = require('../models/User');
const { releaseProduct } = require('./occupancy');
const { notifyUser } = require('../bot/notify');
const { escapeHtml, formatWhen, formatSince } = require('../utils/format');

/**
 * Next-in-line claims, shared by the Telegram bot and the staff website.
 *
 * A power user claims an occupied instrument. The current holder is told at
 * once — Telegram message with Release / Keep buttons, and the same choice on
 * their staff page. Releasing (or returning the item normally) hands it
 * straight to the claimant; keeping it tells the claimant no.
 */

// Power users only, item must be with someone else, one claim per item.
async function createClaim({ product, user, reason, source = 'telegram' }) {
  if (user.accountType !== 'power') {
    const err = new Error('Only power accounts can claim the next turn');
    err.code = 'NOT_POWER';
    throw err;
  }
  if (!product.assignedTo) {
    const err = new Error('This instrument is free — just occupy it');
    err.code = 'NOT_OCCUPIED';
    throw err;
  }
  if (String(product.assignedTo) === String(user._id)) {
    const err = new Error('It is already with you');
    err.code = 'ALREADY_YOURS';
    throw err;
  }

  const existing = await NextClaim.findOne({ product: product._id, status: 'waiting' }).lean();
  if (existing) {
    const err = new Error(
      String(existing.user) === String(user._id)
        ? 'You are already next in line for this one'
        : `${existing.userName} is already next in line`
    );
    err.code = String(existing.user) === String(user._id) ? 'ALREADY_CLAIMED' : 'QUEUE_TAKEN';
    throw err;
  }

  const holder = await User.findById(product.assignedTo).lean();

  const claim = await NextClaim.create({
    product: product._id,
    productName: product.name,
    assetTag: product.assetTag,
    imageUrl: product.imageUrl || null,
    user: user._id,
    userName: user.name,
    holder: holder ? holder._id : null,
    holderName: holder ? holder.name : null,
    reason: (reason || '').trim().slice(0, 120) || null,
    source,
  });

  // Tell the holder straight away, with one-tap buttons
  if (holder && holder.telegramChatId) {
    notifyUser(
      holder.telegramChatId,
      `⚡ <b>${escapeHtml(user.name)}</b> needs <b>${escapeHtml(product.name)}</b> ` +
        `<code>${escapeHtml(product.assetTag)}</code> next.\n` +
        (claim.reason ? `📝 ${escapeHtml(claim.reason)}\n` : '') +
        `You have had it since ${formatWhen(product.occupiedAt)} (${formatSince(product.occupiedAt)}).\n\n` +
        `Release it now and it goes straight to them — or keep it, and they will get it automatically whenever you return it.`,
      {
        inline_keyboard: [
          [
            { text: '✅ Release now', callback_data: `hrel:${claim._id}` },
            { text: '🙅 Keep it for now', callback_data: `hkeep:${claim._id}` },
          ],
        ],
      }
    );
  }

  return claim;
}

/**
 * The holder releases: return the item, which auto-hands it to the claimant.
 * `holderUser` must actually be holding the instrument.
 */
async function releaseForClaim(claimId, holderUser) {
  const claim = await NextClaim.findOne({ _id: claimId, status: 'waiting' });
  if (!claim) return { ok: false, message: 'That request has already been dealt with' };

  const product = await Product.findById(claim.product);
  if (!product) return { ok: false, message: 'That instrument no longer exists' };
  if (!product.assignedTo || String(product.assignedTo) !== String(holderUser._id)) {
    return { ok: false, message: 'That one is not with you any more' };
  }

  // releaseProduct fulfils the waiting claim automatically
  await releaseProduct({ product, source: 'telegram' });

  const fresh = await NextClaim.findById(claim._id).lean();
  const handedOver = fresh && fresh.status === 'fulfilled';
  return {
    ok: true,
    message: handedOver
      ? `Released — ${product.name} is now with ${claim.userName}`
      : `Released — ${product.name} is back, but could not be handed over`,
    claim: fresh,
  };
}

// The holder keeps it; the claimant is told.
async function keepDespiteClaim(claimId, holderUser) {
  const claim = await NextClaim.findOne({ _id: claimId, status: 'waiting' });
  if (!claim) return { ok: false, message: 'That request has already been dealt with' };

  const product = await Product.findById(claim.product).lean();
  if (product && (!product.assignedTo || String(product.assignedTo) !== String(holderUser._id))) {
    return { ok: false, message: 'That one is not with you any more' };
  }

  claim.status = 'declined';
  claim.decidedAt = new Date();
  claim.decisionNote = `${holderUser.name} kept it for now`;
  await claim.save();

  const claimant = await User.findById(claim.user).lean();
  if (claimant && claimant.telegramChatId) {
    notifyUser(
      claimant.telegramChatId,
      `🙅 <b>${escapeHtml(holderUser.name)}</b> still needs <b>${escapeHtml(claim.productName)}</b> ` +
        `<code>${escapeHtml(claim.assetTag || '')}</code> and kept it for now.\n` +
        `You can claim it again later, or book it for a date.`
    );
  }

  return { ok: true, message: 'Kept — the claimant has been told', claim };
}

module.exports = { createClaim, releaseForClaim, keepDespiteClaim };
