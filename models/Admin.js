const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Additional admin accounts, created by any existing admin.
 *
 * The root admin still lives in `.env` (ADMIN_EMAIL / ADMIN_PASSWORD) and can
 * never be edited or removed from the panel. Admins in this collection can
 * sign in to the web panel and to the Telegram bot with the same email and
 * password. Once linked to a Telegram chat they receive every request and
 * booking notification, with approve/decline buttons right in the chat.
 */
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
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Who added this admin — the root admin's email or another admin's
    createdBy: { type: String, trim: true, default: null },

    // Set once the admin signs in through the Telegram bot
    telegramChatId: { type: String, default: null, index: true },
    telegramUsername: { type: String, default: null },
    telegramLinkedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

adminSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
