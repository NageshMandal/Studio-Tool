const mongoose = require('mongoose');

/**
 * "We don't have this — can we get one?"
 *
 * A staff member (typically sales, who hit missing kit first out in the
 * field) asks their own studio to buy something that is not on the shelf.
 *
 * Two rules make this different from every other model in the app, and both
 * are deliberate:
 *
 *  1. It is LOCATION-PRIVATE. The request is raised for one studio and only
 *     the admins of that studio ever see it. It is not a company-wide
 *     purchase queue.
 *
 *  2. The SUPER ADMIN CANNOT SEE IT. This is the one part of the system the
 *     top of the hierarchy is deliberately excluded from — it is the
 *     location admin's own budget conversation with their own team. The
 *     exclusion is enforced in the route layer (blockSuper) rather than
 *     being left to whoever writes the next query.
 *
 * Anything the studio needs beyond the fixed fields goes into `extraFields`
 * as free label/value pairs, so a studio can ask for a lens mount, a room
 * number or a client name without a schema change.
 */

const STATUSES = ['pending', 'approved', 'ordered', 'received', 'rejected', 'cancelled'];

const STATUS_LABELS = {
  pending: 'Waiting on admin',
  approved: 'Approved',
  ordered: 'Ordered',
  received: 'Received',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const URGENCIES = ['low', 'normal', 'high', 'urgent'];

const procurementRequestSchema = new mongoose.Schema(
  {
    /**
     * The studio this is being asked FOR. Copied from the requester at
     * creation time and never editable — a request raised at Patna can
     * never quietly become a Ranchi request.
     */
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: true,
      index: true,
    },
    locationName: { type: String, trim: true },

    // Sequential per studio, for referring to one out loud: PAT-REQ-014
    reference: { type: String, trim: true, uppercase: true, index: true },

    /* ---- what they are asking for ---- */

    itemName: {
      type: String,
      required: [true, 'What is the item called?'],
      trim: true,
      maxlength: [120, 'Keep the item name under 120 characters'],
    },

    category: {
      type: String,
      trim: true,
      default: 'Other',
    },

    quantity: {
      type: Number,
      min: [1, 'Ask for at least one'],
      default: 1,
    },

    reason: {
      type: String,
      required: [true, 'Say why this is needed'],
      trim: true,
      maxlength: [600, 'Keep the reason under 600 characters'],
    },

    // Optional: where it can be bought
    purchaseUrl: {
      type: String,
      trim: true,
      default: null,
    },

    // Optional: what they think it costs, per unit
    estimatedPrice: {
      type: Number,
      min: 0,
      default: null,
    },

    urgency: {
      type: String,
      enum: URGENCIES,
      default: 'normal',
    },

    // When they need it by, as 'YYYY-MM-DD'. Optional.
    neededBy: {
      type: String,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      default: null,
    },

    /**
     * Anything else the studio wants recorded. Free-form so a studio can
     * capture what matters to them without a code change.
     */
    extraFields: [
      {
        _id: false,
        label: { type: String, trim: true, maxlength: 60 },
        value: { type: String, trim: true, maxlength: 300 },
      },
    ],

    /* ---- who asked ---- */

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requesterName: { type: String, trim: true },
    requesterRole: { type: String, trim: true },
    requesterDepartment: { type: String, trim: true },

    /* ---- what happened to it ---- */

    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
      index: true,
    },

    decidedAt: { type: Date, default: null },
    // The location admin who decided, for the audit trail
    decidedBy: { type: String, trim: true, default: null },
    decisionNote: { type: String, trim: true, maxlength: 400, default: null },

    // Filled in when the studio actually buys it
    approvedBudget: { type: Number, min: 0, default: null },
    orderedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },

    // Set once the bought item is added to the register
    linkedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  },
  { timestamps: true }
);

// The location admin's queue: my studio, newest first
procurementRequestSchema.index({ location: 1, status: 1, createdAt: -1 });

// Give each request a per-studio reference: PAT-REQ-0001
procurementRequestSchema.pre('save', async function (next) {
  if (this.reference) return next();
  try {
    const Counter = require('./Counter');
    const Location = require('./Location');
    const studio = await Location.findById(this.location).lean();
    const prefix = studio ? studio.code : 'STU';
    const counter = await Counter.findByIdAndUpdate(
      `procurement:${prefix}`,
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.reference = `${prefix}-REQ-${String(counter.seq).padStart(4, '0')}`;
    next();
  } catch (err) {
    next(err);
  }
});

// A request that has not been decided is still open to the requester
procurementRequestSchema.virtual('isOpen').get(function () {
  return this.status === 'pending';
});

procurementRequestSchema.set('toJSON', { virtuals: true });
procurementRequestSchema.set('toObject', { virtuals: true });

procurementRequestSchema.statics.STATUSES = STATUSES;
procurementRequestSchema.statics.STATUS_LABELS = STATUS_LABELS;
procurementRequestSchema.statics.URGENCIES = URGENCIES;

module.exports = mongoose.model('ProcurementRequest', procurementRequestSchema);
module.exports.STATUSES = STATUSES;
module.exports.STATUS_LABELS = STATUS_LABELS;
module.exports.URGENCIES = URGENCIES;
