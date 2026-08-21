const mongoose = require('mongoose');
const {
  emptyModulePermission,
  MODULE_KEYS,
  ACTIONS
} = require('../config/rbac');
const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  permissions: {
    type: mongoose.Schema.Types.Mixed,
    default: () => {
      const perms = {};
      MODULE_KEYS.forEach(k => {
        perms[k] = emptyModulePermission();
      });
      return perms;
    }
  },
  countries: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country'
  }],
  allCountries: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});
module.exports = mongoose.model('Department', departmentSchema);
