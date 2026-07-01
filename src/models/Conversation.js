const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  
  type: { type: String, enum: ['direct', 'group'], required: true },
  
  name: { type: String, trim: true },
  
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  lastMessageAt: { type: Date },
}, { timestamps: true });

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
