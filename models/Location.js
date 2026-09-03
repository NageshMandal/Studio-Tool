const mongoose = require('mongoose');

/**
 * A studio location: Patna, Ranchi, Kolkata …
 *
 * This is the spine of the whole permission model. Every item, person,
 * request, booking and log row belongs to exactly one location, and every
 * query outside the super admin's own pages is filtered by it.
 *
 * Only the super admin can create, edit or archive a location.
 */

// The accent used across the studio's cards, badges and dashboard.
// Matching CSS lives in public/css/style.css as .theme-<key>.
const THEMES = ['green', 'blue', 'purple', 'amber', 'rose', 'teal'];

const locationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Studio name is required'],
      trim: true,
      unique: true,
    },

    /**
     * Short uppercase key used in asset tags (PAT-0001, RAN-0001 …) and in
     * URLs. Immutable once set, because changing it would orphan every tag
     * already printed and stuck on a camera case.
     */
    code: {
      type: String,
      required: [true, 'Studio code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      minlength: [2, 'Use 2–5 letters for the code'],
      maxlength: [5, 'Use 2–5 letters for the code'],
      match: [/^[A-Z]+$/, 'The code may only contain letters'],
    },

    city: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },

    theme: { type: String, enum: THEMES, default: 'blue' },

    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },

    // The super admin's email, for the audit trail
    createdBy: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

locationSchema.statics.THEMES = THEMES;

// A friendly label for dropdowns and log lines: "Patna (PAT)"
locationSchema.virtual('label').get(function () {
  return `${this.name} (${this.code})`;
});

locationSchema.set('toJSON', { virtuals: true });
locationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Location', locationSchema);
