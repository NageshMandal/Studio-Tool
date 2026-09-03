const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Admin accounts. Three tiers, in descending power:
 *
 *  super           The primary admin. Lives in `.env` (ADMIN_EMAIL /
 *                  ADMIN_PASSWORD) and can never be edited or deleted from
 *                  the panel. Creates studios, creates the location admin
 *                  for each studio, and can open every studio's dashboard
 *                  plus the master dashboard across all of them.
 *                  Extra super admins can be added to this collection, but
 *                  only by the root one.
 *
 *  location_admin  The primary admin FOR ONE STUDIO. Created by a super
 *                  admin, locked to a single location. Sees only that
 *                  studio's items, people, requests and reports — and is
 *                  the one who handles staff item requests (procurement),
 *                  which the super admin deliberately never sees. May
 *                  create location managers beneath them.
 *
 *  location_manager  A second-line admin for the same studio. Everything a
 *                  location admin can do EXCEPT managing admin accounts,
 *                  deleting items or deleting people. Not a primary admin.
 *
 * A super admin's `location` is always null. The other two always carry one.
 */

const ROLES = ['super', 'location_admin', 'location_manager'];

const ROLE_LABELS = {
  super: 'Super admin',
  location_admin: 'Location admin',
  location_manager: 'Location manager',
};

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,
    },

    role: {
      type: String,
      enum: ROLES,
      default: 'location_manager',
      required: true,
    },

    /**
     * The studio this admin belongs to. Required for everyone except a
     * super admin, who works across all of them. Enforced in the hook below
     * rather than with `required` so the message reads properly.
     */
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      default: null,
      index: true,
    },

    phone: { type: String, trim: true, default: '' },

    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },

    // Who added this admin, for the audit trail
    createdBy: { type: String, trim: true, default: null },

    lastLoginAt: { type: Date, default: null },

    // Set once the admin signs in through the Telegram bot
    telegramChatId: { type: String, default: null, index: true },
    telegramUsername: { type: String, default: null },
    telegramLinkedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A location admin without a location could see nothing at all; a super
// admin with one would be silently limited. Both are bugs, so refuse them.
adminSchema.pre('validate', function (next) {
  if (this.role === 'super') {
    this.location = null;
  } else if (!this.location) {
    return next(new Error('Pick the studio this admin belongs to'));
  }
  next();
});

adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

adminSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

adminSchema.statics.ROLES = ROLES;
adminSchema.statics.ROLE_LABELS = ROLE_LABELS;

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ROLES = ROLES;
module.exports.ROLE_LABELS = ROLE_LABELS;
