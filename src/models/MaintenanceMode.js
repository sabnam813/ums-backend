const mongoose = require('mongoose');
const maintenanceModeSchema = new mongoose.Schema({
  key: {
    type: String,
    default: 'singleton',
    unique: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  message: {
    type: String,
    default: 'The system is undergoing scheduled maintenance. Please check back shortly.'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
module.exports = mongoose.model('MaintenanceMode', maintenanceModeSchema);
