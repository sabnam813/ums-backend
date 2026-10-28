const mongoose = require('mongoose');
const dailyReportSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: String,
    required: true
  },
  department: {
    type: String,
    trim: true,
    default: ''
  },
  points: [{
    type: String,
    trim: true,
    maxlength: 2000
  }],
  feedback: {
    type: String,
    trim: true,
    maxlength: 4000,
    default: ''
  },
  feedbackBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  feedbackAt: {
    type: Date
  }
}, {
  timestamps: true
});
dailyReportSchema.index({
  user: 1,
  date: 1
}, {
  unique: true
});
module.exports = mongoose.model('DailyReport', dailyReportSchema);
