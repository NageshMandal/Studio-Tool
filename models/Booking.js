const mongoose = require('mongoose');

/**
 * An advance reservation: "I want this instrument on that day."
 *
 * A power user's booking is confirmed on the spot. A normal user's booking
 * sits at 'pending' until an admin approves it — same rule as taking an item
 * out right now. The day is stored as a 'YYYY-MM-DD' key in the configured
 * timezone, so "is it booked on the 20th?" is a plain string match.
 *
 * A booking does not occupy the item by itself. On the day, the person still
 * taps Occupy / Request as usual — the booking reserves their priority: while
 * a confirmed booking is live for today, nobody else can take the item.
 */
const bookingSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true },

    // The whole day being reserved, as 'YYYY-MM-DD'
    bookedFor: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    reason: { type: String, trim: true, maxlength: 120, default: null },

    status: {
      type: String,
      enum: ['pending', 'confirmed', 'declined', 'cancelled'],
      default: 'pending',
    },

    source: { type: String, enum: ['telegram', 'web'], default: 'telegram' },

    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 200, default: null },
    // Which admin decided it (email or name), for the audit trail
    decidedBy: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

bookingSchema.index({ product: 1, bookedFor: 1, status: 1 });
bookingSchema.index({ user: 1, status: 1, bookedFor: 1 });
bookingSchema.index({ status: 1, bookedFor: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
