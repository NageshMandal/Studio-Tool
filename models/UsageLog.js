const mongoose = require('mongoose');

/**
 * One document per "someone took an instrument out and brought it back".
 * occupiedAt is set when it goes out, returnedAt when it comes back.
 * A document with returnedAt === null means the item is still out.
 *
 * Names and asset tags are copied in on purpose: the log should still read
 * correctly after an instrument or a person is deleted from the register.
 */
const usageLogSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: { type: String, trim: true },

    occupiedAt: { type: Date, required: true, default: Date.now },
    returnedAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: null },

    // Why the item was taken, captured at the moment it went out
    reason: { type: String, trim: true, maxlength: 120, default: null },

    source: { type: String, enum: ['telegram', 'admin'], default: 'telegram' },
    returnSource: { type: String, enum: ['telegram', 'admin'], default: null },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

usageLogSchema.index({ occupiedAt: -1 });
usageLogSchema.index({ product: 1, returnedAt: 1 });

usageLogSchema.virtual('isOpen').get(function () {
  return this.returnedAt === null;
});

module.exports = mongoose.model('UsageLog', usageLogSchema);
