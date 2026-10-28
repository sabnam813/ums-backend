const mongoose = require('mongoose');
const backupSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true
  },
  sizeBytes: {
    type: Number,
    default: 0
  },
  type: {
    type: String,
    enum: ['auto', 'manual', 'pre-restore'],
    default: 'manual'
  },
  counts: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
module.exports = mongoose.model('Backup', backupSchema);
