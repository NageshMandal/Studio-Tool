const mongoose = require('mongoose');

/**
 * A message from the admin to one staff member, kept so it can be shown on
 * the staff dashboard.
 *
 * Telegram messages disappear into the chat history and are missed entirely
 * by anyone who has not linked their account. A notification row is the
 * durable copy: it survives, it can be marked read, and it is the same
 * record whether the admin decided from the panel or from the inline
 * buttons in their own Telegram chat.
 *
 * Names, tags and days are copied in so the row still reads correctly after
 * the request, booking or instrument it refers to is deleted.
 */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    kind: {
      type: String,
      enum: [
        'request-rejected',
        // A submission the admin sent back — the item is still with them
        'return-declined',
        'booking-declined',
        'booking-cancelled',
        'purchase-approved',
        'purchase-rejected',
        'purchase-update',
      ],
      required: true,
    },

    // One line, already written for a human: "Request declined"
    title: { type: String, trim: true, required: true },

    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },

    // For booking notifications, the day that was asked for ('YYYY-MM-DD')
    bookedFor: { type: String, trim: true, default: null },

    // What the person originally asked for
    reason: { type: String, trim: true, maxlength: 200, default: null },

    // Why the admin said no (their note, or the automatic reason)
    note: { type: String, trim: true, maxlength: 200, default: null },

    // Which admin decided, for the audit trail
    decidedBy: { type: String, trim: true, default: null },

    // What this refers back to, if it still exists
    refModel: {
      type: String,
      enum: ['AssignmentRequest', 'Booking', 'ProcurementRequest'],
      default: null,
    },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Null until the person dismisses it from the dashboard
    readAt: { type: Date, default: null },

    // True when the Telegram copy actually went out, so the dashboard can
    // say "you were not messaged" to someone who has not linked their chat
    sentToTelegram: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// The dashboard query: my unread ones, newest first
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
