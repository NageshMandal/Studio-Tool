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
 *                  create location sub admins beneath them.
 *
 *  location_sub_admin  A second-line admin for the same studio. Everything a
 *                  location admin can do EXCEPT managing admin accounts,
 *                  deleting items or deleting people. Not a primary admin.
 *
 * A super admin's `location` is always null. The other two always carry one.
 */

const ROLES = ['super', 'location_admin', 'location_sub_admin'];

const ROLE_LABELS = {
  super: 'Super admin',
  location_admin: 'Location admin',
  location_sub_admin: 'Location sub admin',
};

/**
 * The old key for the third tier, before it was renamed to "location sub
 * admin". Accounts created under the old name are migrated on boot (see
 * `migrateRoles` below); this constant is what does the finding, and is the
 * only place the retired name still appears.
 */
const LEGACY_SUB_ADMIN_ROLE = 'location_manager';

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
      default: 'location_sub_admin',
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
adminSchema.statics.LEGACY_SUB_ADMIN_ROLE = LEGACY_SUB_ADMIN_ROLE;

/**
 * Moves any account still on the old `location_manager` key onto
 * `location_sub_admin`. Runs once at boot, and is a no-op every time after.
 *
 * This is not optional tidying. The capability map matches on the role
 * string, so an account left on the retired key would fall through every
 * branch and quietly lose its access — the person could still sign in, but
 * purchase requests and everything else would simply not be there, with no
 * error to explain it. Renaming the key without this would lock people out.
 *
 * `strict: false` is needed because the value being searched for is no
 * longer in the schema's enum.
 */
adminSchema.statics.migrateRoles = async function migrateRoles() {
  const result = await this.updateMany(
    { role: LEGACY_SUB_ADMIN_ROLE },
    { $set: { role: 'location_sub_admin' } },
    { strict: false }
  );
  return result.modifiedCount || 0;
};

module.exports = mongoose.model('Admin', adminSchema);
module.exports.ROLES = ROLES;
module.exports.ROLE_LABELS = ROLE_LABELS;
module.exports.LEGACY_SUB_ADMIN_ROLE = LEGACY_SUB_ADMIN_ROLE;
