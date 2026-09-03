const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * A staff member. Everyone belongs to exactly one studio and only ever
 * sees that studio's equipment — in the web portal and in the Telegram bot.
 */

/**
 * Starting suggestions only — the department field is free text.
 *
 * It used to be a fixed enum, which meant a studio with a "Post Production"
 * or "Client Servicing" team either had to file them under Other or wait for
 * a code change. These now just seed the datalist on the form; anything a
 * studio actually types is offered alongside them from then on.
 */
const SUGGESTED_DEPARTMENTS = [
  'Studio',
  'Editing',
  'Design',
  'Production',
  'Sales',
  'Admin',
  'Other',
];

// What the person does day to day. 'sales' is called out separately because
// sales staff are the ones out in the field who hit missing kit first, so
// their "please buy this" requests are the ones the location admin expects.
const STAFF_ROLES = ['staff', 'sales'];

const userSchema = new mongoose.Schema(
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

    /**
     * The studio this person works at. Everything they can see is filtered
     * by it, so it is required — a person with no studio would open an
     * empty portal and never understand why.
     */
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Location',
      required: [true, 'Pick the studio this person works at'],
      index: true,
    },

    employeeId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    /**
     * Free text, so each studio can name its own teams. Whitespace is
     * collapsed on save so "Post  Production" and "Post Production " do not
     * become two separate departments in the filter list.
     */
    department: {
      type: String,
      trim: true,
      maxlength: [60, 'Keep the department name under 60 characters'],
      default: 'Studio',
      /**
       * Normalising in the setter rather than a pre-validate hook means it
       * applies the moment the value is assigned — hooks are skipped by
       * validateSync() and by direct updates, which would let a blank or
       * untrimmed department slip through by either route.
       */
      set: (v) => {
        if (typeof v !== 'string') return v;
        const clean = v.replace(/\s+/g, ' ').trim();
        return clean || 'Studio';
      },
    },
    designation: {
      type: String,
      trim: true,
    },

    staffRole: {
      type: String,
      enum: STAFF_ROLES,
      default: 'staff',
    },

    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },

    /**
     * What the person may do with equipment:
     *  - 'power'  — can occupy an available item immediately, no approval.
     *  - 'normal' — can only *request* an item; an admin at their studio has
     *               to approve it before it is handed over.
     */
    accountType: {
      type: String,
      enum: ['power', 'normal'],
      default: 'normal',
    },

    // Set once the person signs in through the Telegram bot
    telegramChatId: {
      type: String,
      default: null,
      index: true,
    },
    telegramUsername: { type: String, default: null },
    telegramLinkedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Hash the password whenever it is set or changed
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', userSchema);
module.exports.SUGGESTED_DEPARTMENTS = SUGGESTED_DEPARTMENTS;
module.exports.STAFF_ROLES = STAFF_ROLES;
