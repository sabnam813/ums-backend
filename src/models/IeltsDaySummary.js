const mongoose = require('mongoose');
const ieltsDaySummarySchema = new mongoose.Schema({
  testType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestType',
    required: true
  },
  examDate: {
    type: Date,
    required: true
  },
  paidOnDate: {
    type: Date
  },
  preparedBy: {
    type: String,
    trim: true,
    default: ''
  },
  checkedBy: {
    type: String,
    trim: true,
    default: ''
  },
  approvedBy: {
    type: String,
    trim: true,
    default: ''
  }
}, {
  timestamps: true
});
ieltsDaySummarySchema.index({
  testType: 1,
  examDate: 1
}, {
  unique: true
});
module.exports = mongoose.model('IeltsDaySummary', ieltsDaySummarySchema);
