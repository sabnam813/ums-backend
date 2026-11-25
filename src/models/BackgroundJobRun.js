const mongoose = require('mongoose');
const backgroundJobRunSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    index: true
  },
  label: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['success', 'failed'],
    required: true
  },
  durationMs: {
    type: Number,
    default: 0
  },
  message: {
    type: String,
    default: ''
  },
  trigger: {
    type: String,
    enum: ['schedule', 'manual'],
    default: 'schedule'
  }
}, {
  timestamps: true
});
backgroundJobRunSchema.index({
  createdAt: -1
});
backgroundJobRunSchema.index({
  createdAt: 1
}, {
  expireAfterSeconds: 60 * 60 * 24 * 60
});
module.exports = mongoose.model('BackgroundJobRun', backgroundJobRunSchema);
