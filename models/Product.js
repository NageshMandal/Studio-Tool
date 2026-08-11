const mongoose = require('mongoose');

const Counter = require('./Counter');

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Instrument name is required'],
      trim: true,
    },
    assetTag: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        'Camera',
        'Lens',
        'Lighting',
        'Audio',
        'Computer',
        'Accessory',
        'Furniture',
        'Other',
      ],
      default: 'Other',
    },
    brand: { type: String, trim: true },
    model: { type: String, trim: true },
    serialNumber: { type: String, trim: true },
    quantity: {
      type: Number,
      default: 1,
      min: [0, 'Quantity cannot be negative'],
    },
    condition: {
      type: String,
      enum: ['new', 'good', 'needs-repair', 'retired'],
      default: 'good',
    },
    status: {
      type: String,
      enum: ['available', 'assigned', 'maintenance'],
      default: 'available',
    },
    location: { type: String, trim: true, default: 'Main studio' },
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
  },
  { timestamps: true }
);

// Give every instrument a printable asset tag: STU-0001, STU-0002 ...
productSchema.pre('save', async function (next) {
  if (this.assetTag) return next();
  try {
    const counter = await Counter.findByIdAndUpdate(
      'assetTag',
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.assetTag = `STU-${String(counter.seq).padStart(4, '0')}`;
    next();
  } catch (err) {
    next(err);
  }
});

// An instrument with nobody holding it is available again
productSchema.pre('save', function (next) {
  if (!this.assignedTo && this.status === 'assigned') this.status = 'available';
  if (this.assignedTo && this.status === 'available') this.status = 'assigned';
  next();
});

module.exports = mongoose.model('Product', productSchema);
