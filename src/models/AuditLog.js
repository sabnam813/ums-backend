const mongoose = require('mongoose');
const auditLogSchema = new mongoose.Schema({
  actor: {
    id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    username: String,
    role: String
  },
  action: {
    type: String,
    required: true,
    index: true
  },
  targetType: {
    type: String,
    default: null
  },
  targetId: {
    type: String,
    default: null
  },
  message: {
    type: String,
    default: ''
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  ip: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});
auditLogSchema.index({
  createdAt: -1
});
module.exports = mongoose.model('AuditLog', auditLogSchema);
