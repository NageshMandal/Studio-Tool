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
    returnedAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: null },

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

module.exports = mongoose.model('UsageLog', usageLogSchema);
