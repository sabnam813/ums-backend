const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  getDefaultPermissions,
  normalizePermissions
} = require('../config/rbac');
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    trim: true
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'user'],
    default: 'user'
  },
  department: {
    type: String,
    trim: true,
    default: ''
  },
  departments: [{
    type: String,
    trim: true
  }],
  countries: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country'
  }],
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  permissions: {
    type: mongoose.Schema.Types.Mixed,
    default: () => getDefaultPermissions('user')
  },
  lastLogin: {
    type: Date
  },
  sessions: [{
    tokenId: {
      type: String,
      required: true
    },
    refreshToken: {
      type: String,
      required: true
    },
    previousRefreshToken: {
      type: String,
      default: null
    },
    previousTokenExpiresAt: {
      type: Date,
      default: null
    },
    ip: {
      type: String,
      default: ''
    },
    userAgent: {
      type: String,
      default: ''
    },
    rememberMe: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    lastUsedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date
    }
  }],
  mustChangePassword: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.sessions;
  obj.permissions = normalizePermissions(obj.permissions);
  return obj;
};
module.exports = mongoose.model('User', userSchema);
