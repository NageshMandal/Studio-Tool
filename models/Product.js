const mongoose = require('mongoose');

const Counter = require('./Counter');
const Location = require('./Location');

const CATEGORIES = [
  'Camera',
  'Lens',
  'Memory',
  'Audio',
  'Tripod',
  'Lighting',
  'Accessory',
  'Mic ID',
  'Other',
];

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },

    /**
     * The studio that owns this item. An item belongs to one studio and is
     * invisible to every other one — this field is what makes that true.
     */
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: [true, 'Pick the studio this item belongs to'],
      index: true,
    },

    /**
     * Printed on the case: PAT-0001, RAN-0001, KOL-0001 …
     * Prefixed with the studio code so a tag alone tells you where the item
     * lives, and so two studios never fight over the same number.
     */
    assetTag: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
    },

    category: {
      type: String,
      enum: CATEGORIES,
      default: 'Other',
    },
    brand: { type: String, trim: true },
    model: { type: String, trim: true },
    serialNumber: { type: String, trim: true },
    condition: {
      type: String,
      enum: ['new', 'good', 'needs-repair', 'retired'],
      default: 'good',
    },
    /**
     * `pending-return` is the gap between a staff member handing an item
     * back and an admin checking it in. It is deliberately not 'available':
     * nobody should be given an item whose condition has not been looked at
     * yet, and that check is the whole reason the two-step return exists.
     */
    status: {
      type: String,
      enum: ['available', 'assigned', 'maintenance', 'pending-return'],
      default: 'available',
    },

    // Where inside the studio it is kept — shelf, rack, cupboard
    storageArea: { type: String, trim: true, default: 'Main store' },

    purchaseDate: { type: Date },
    price: { type: Number, min: 0, default: 0 },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // When the current holder picked it up. Null whenever the item is in store.
    occupiedAt: {
      type: Date,
      default: null,
    },
    // Why they took it, in a few words. Cleared when the item comes back.
    occupyReason: {
      type: String,
      trim: true,
      maxlength: [120, 'Keep the reason under 120 characters'],
      default: null,
    },
    imageUrl: { type: String, trim: true },
    notes: { type: String, trim: true },

    /**
     * Set when this item was added as the result of an approved staff
     * purchase request, so the request can show "this is now on the shelf".
     */
    fromProcurement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProcurementRequest',
      default: null,
    },
  },
  { timestamps: true }
);

// One item cannot be in two studios, and lookups are always studio-first
productSchema.index({ location: 1, category: 1, name: 1 });
productSchema.index({ location: 1, status: 1 });

// Give every item a printable asset tag, numbered per studio
productSchema.pre('save', async function (next) {
  if (this.assetTag) return next();
  try {
    const studio = await Location.findById(this.location).lean();
    const prefix = studio ? studio.code : 'STU';
    const counter = await Counter.findByIdAndUpdate(
      `assetTag:${prefix}`,
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.assetTag = `${prefix}-${String(counter.seq).padStart(4, '0')}`;
    next();
  } catch (err) {
    next(err);
  }
});

// An item with nobody holding it is available again
productSchema.pre('save', function (next) {
  if (!this.assignedTo && this.status === 'assigned') this.status = 'available';
  if (this.assignedTo && this.status === 'available') this.status = 'assigned';
  next();
});

module.exports = mongoose.model('Product', productSchema);
module.exports.CATEGORIES = CATEGORIES;
