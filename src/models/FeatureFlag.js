const mongoose = require('mongoose');
const featureFlagSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  label: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});
module.exports = mongoose.model('FeatureFlag', featureFlagSchema);
