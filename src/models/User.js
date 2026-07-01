const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  name: { type: String, trim: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  countries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Country' }],
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  lastLogin: { type: Date },
  refreshToken: { type: String },
  refreshTokens: [{ type: String }],
  mustChangePassword: { type: Boolean, default: false },
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.refreshTokens;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
