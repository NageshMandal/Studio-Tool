const mongoose = require('mongoose');

/**
 * An advance reservation: "I want this item on that day."
 *
 * Every booking waits for an admin AT THAT STUDIO to confirm or cancel it.
 * The day is stored as a 'YYYY-MM-DD' key in the configured timezone, so
 * "is it booked on the 20th?" is a plain string match.
 *
 * A booking does not occupy the item by itself. On the day, the person still
 * taps Occupy / Request as usual — the booking reserves their priority:
 * while a confirmed booking is live for today, nobody else can take it.
 */
const bookingSchema = new mongoose.Schema(
  {
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
      index: true,
    },
    locationName: { type: String, trim: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true },

    // The whole day being reserved (the pickup day), as 'YYYY-MM-DD'
    bookedFor: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    // Planned pickup time on the booked day, as 'HH:MM' (24h). Optional so
    // Telegram bookings, which only ask for a date, keep working.
    pickupTime: { type: String, trim: true, match: /^\d{2}:\d{2}$/, default: null },

    // Planned drop-off (return) day and time. dropDate is never before
    // bookedFor. Optional for the same reason as pickupTime.
    dropDate: { type: String, trim: true, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
    dropTime: { type: String, trim: true, match: /^\d{2}:\d{2}$/, default: null },

    reason: { type: String, trim: true, maxlength: 120, default: null },

    status: {
      type: String,
      enum: ['pending', 'confirmed', 'declined', 'cancelled'],
      default: 'pending',
    },

    /**
     * True while the item is still out with someone else: the holder has
     * been asked to submit it, and the admins are only notified to
     * confirm/cancel once it comes back. False from the start when the item
     * was free (admins are notified immediately).
     */
    awaitingReturn: { type: Boolean, default: false },

    source: { type: String, enum: ['telegram', 'web'], default: 'telegram' },

    decidedAt: { type: Date, default: null },

    /**
     * Set when the item was actually handed to the booker on the booked day
     * (auto-assignment). A confirmed booking with fulfilledAt === null is
     * still waiting for its day, or for the item to come back.
     */
    fulfilledAt: { type: Date, default: null },

    decisionNote: { type: String, trim: true, maxlength: 200, default: null },
    // Which admin decided it (email or name), for the audit trail
    decidedBy: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

bookingSchema.index({ product: 1, bookedFor: 1, status: 1 });
bookingSchema.index({ user: 1, status: 1, bookedFor: 1 });
bookingSchema.index({ location: 1, status: 1, bookedFor: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
