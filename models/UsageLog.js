const mongoose = require('mongoose');

/**
 * One document per "someone took an item out and brought it back".
 * occupiedAt is set when it goes out, returnedAt when it comes back.
 * A document with returnedAt === null means the item is still out.
 *
 * Names, asset tags and the studio are copied in on purpose: the log should
 * still read correctly after an item, a person or even a studio is removed
 * from the register. The monthly report is built entirely from these rows.
 */
const usageLogSchema = new mongoose.Schema(
  {
    // The studio the item belongs to, copied in so reports never need a join
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
      index: true,
    },
    locationName: { type: String, trim: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    category: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String, trim: true },

    occupiedAt: { type: Date, required: true, default: Date.now },

    /**
     * A return happens in two steps, and both are recorded here.
     *
     *   returnedAt   the moment the STAFF handed the item back. This is the
     *                submission date, and it is what ends the loan — every
     *                duration, report and "still out" test keys off it, as
     *                it always has.
     *   acceptedAt   the moment the ADMIN checked the item in.
     *
     * Each side leaves a remark, which is the point of splitting the two:
     * if something happened to an item, both accounts of it are on the same
     * row, timestamped, rather than being argued about later from memory.
     * Between the two moments the item is not on the shelf and not with
     * anybody — see Product's `pending-return` status.
     */
    returnedAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: null },

    // The staff member's account of the item's condition. Required when they
    // submit; 'NA' is a perfectly good answer and the one most often true.
    submitRemark: { type: String, trim: true, maxlength: 300, default: null },

    acceptedAt: { type: Date, default: null },
    acceptRemark: { type: String, trim: true, maxlength: 300, default: null },
    // Which admin accepted it (email or name), for the audit trail
    acceptedBy: { type: String, trim: true, default: null },
    // The condition the admin recorded on check-in, when they changed it
    acceptCondition: { type: String, trim: true, default: null },

    // Why the item was taken, captured at the moment it went out
    reason: { type: String, trim: true, maxlength: 120, default: null },

    source: { type: String, enum: ['telegram', 'admin', 'web', 'auto'], default: 'telegram' },
    returnSource: { type: String, enum: ['telegram', 'admin', 'web', 'auto'], default: null },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

usageLogSchema.index({ location: 1, occupiedAt: -1 });
usageLogSchema.index({ product: 1, returnedAt: 1 });

usageLogSchema.virtual('isOpen').get(function () {
  return this.returnedAt === null;
});

/**
 * Where this loan has got to: out with somebody, handed back and waiting on
 * an admin, or fully checked in. Derived rather than stored, so it can never
 * disagree with the dates it is derived from.
 */
usageLogSchema.virtual('returnStage').get(function () {
  if (!this.returnedAt) return 'out';
  return this.acceptedAt ? 'accepted' : 'submitted';
});

usageLogSchema.set('toJSON', { virtuals: true });
usageLogSchema.set('toObject', { virtuals: true });

// Finding what is waiting on an admin has to be quick — it is on their queue
usageLogSchema.index({ location: 1, returnedAt: 1, acceptedAt: 1 });

module.exports = mongoose.model('UsageLog', usageLogSchema);
