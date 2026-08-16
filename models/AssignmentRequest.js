const mongoose = require('mongoose');

/**
 * A normal (non-power) user asking for an instrument through the Telegram bot.
 * The request sits at 'pending' until an admin approves or rejects it from the
 * panel. Names and tags are copied in so the row still reads correctly if the
 * instrument or the person is later deleted.
 */
const assignmentRequestSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, trim: true },
    assetTag: { type: String, trim: true },
    imageUrl: { type: String, trim: true, default: null },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true },

    reason: { type: String, trim: true, maxlength: 120, default: null },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },

    // Filled in when the admin decides (or the user cancels)
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, maxlength: 200, default: null },
    // Which admin decided it (email or name), for the audit trail
    decidedBy: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

assignmentRequestSchema.index({ status: 1, createdAt: -1 });
assignmentRequestSchema.index({ user: 1, product: 1, status: 1 });

module.exports = mongoose.model('AssignmentRequest', assignmentRequestSchema);
