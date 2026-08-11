const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
    employeeId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    department: {
      type: String,
      enum: ['Studio', 'Editing', 'Design', 'Production', 'Admin', 'Other'],
      default: 'Studio',
    },
    designation: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
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
