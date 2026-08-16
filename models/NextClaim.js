const mongoose = require('mongoose');

/**
 * "I need this next" — a power user claiming an instrument that is currently
 * with someone else.
 *
 * The current holder is told on Telegram and on their staff page, with
 * Release / Keep buttons. If they release — or simply return the item the
 * normal way — the instrument is handed straight to the claimant instead of
 * going back on the shelf. If they keep it, the claimant is told.
 *
 * One waiting claim per instrument: next in line is a single person.
 */
const nextClaimSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    // Who wants it next
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true },

    // Who was holding it when the claim was made
    holder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    holderName: { type: String, trim: true, default: null },

    reason: { type: String, trim: true, maxlength: 120, default: null },

    status: {
      type: String,
      enum: ['waiting', 'fulfilled', 'declined', 'cancelled', 'expired'],
      default: 'waiting',
    },

    source: { type: String, enum: ['telegram', 'web'], default: 'telegram' },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 200, default: null },
  },
  { timestamps: true }
);

nextClaimSchema.index({ product: 1, status: 1 });
nextClaimSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('NextClaim', nextClaimSchema);
