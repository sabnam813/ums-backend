const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../utils/cryptoUtil');
const { isSafeUrl } = require('../utils/urlSafety');

const portalSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Portal name is required'],
    trim: true,
    maxlength: 150
  },
  username: {
    type: String,
    trim: true,
    default: '',
    maxlength: 200
  },
  passwordEncrypted: {
    type: String,
    default: ''
  },
  url: {
    type: String,
    trim: true,
    default: '',
    validate: {
      validator: function (v) {
        if (!v) return true;
        return isSafeUrl(v);
      },
      message: 'Site link must be a valid http:// or https:// URL'
    }
  },
  category: {
    type: String,
    trim: true,
    default: '',
    maxlength: 100
  },
  notes: {
    type: String,
    trim: true,
    default: '',
    maxlength: 1000
  },
  departments: [{
    type: String,
    trim: true
  }],
  allDepartments: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

portalSchema.index({ name: 1 });
portalSchema.index({ departments: 1 });
portalSchema.index({ status: 1 });

portalSchema.methods.setPassword = function (plainPassword) {
  this.passwordEncrypted = plainPassword ? encrypt(String(plainPassword)) : '';
};

portalSchema.methods.getPassword = function () {
  return this.passwordEncrypted ? decrypt(this.passwordEncrypted) : '';
};

portalSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.passwordEncrypted;
  obj.hasPassword = !!this.passwordEncrypted;
  return obj;
};

module.exports = mongoose.model('Portal', portalSchema);
