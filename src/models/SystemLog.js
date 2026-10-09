const mongoose = require('mongoose');
const systemLogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['request', 'error', 'crash'],
    required: true,
    index: true
  },
  level: {
    type: String,
    enum: ['info', 'warn', 'error', 'fatal'],
    default: 'info',
    index: true
  },
  method: {
    type: String
  },
  path: {
    type: String,
    index: true
  },
  statusCode: {
    type: Number
  },
  durationMs: {
    type: Number
  },
  message: {
    type: String,
    default: ''
  },
  stack: {
    type: String,
    default: ''
  },
  ip: {
    type: String,
    default: ''
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
systemLogSchema.index({
  createdAt: -1
});
systemLogSchema.index({
  createdAt: 1
}, {
  expireAfterSeconds: 60 * 60 * 24 * 30
});
module.exports = mongoose.model('SystemLog', systemLogSchema);
