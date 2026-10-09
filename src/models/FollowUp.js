const mongoose = require('mongoose');
const followUpSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: Date.now,
    required: true
  },
  companyName: {
    type: String,
    trim: true,
    default: ''
  },
  talkedTo: {
    type: String,
    trim: true,
    default: ''
  },
  remarks: {
    type: String,
    trim: true,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
followUpSchema.index({
  date: -1
});
followUpSchema.index({
  createdBy: 1
});
module.exports = mongoose.model('FollowUp', followUpSchema);
