const mongoose = require('mongoose');
const systemAlertSchema = new mongoose.Schema({
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info',
    index: true
  },
  source: {
    type: String,
    default: 'system'
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    default: ''
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});
systemAlertSchema.index({
  createdAt: -1
});
module.exports = mongoose.model('SystemAlert', systemAlertSchema);
