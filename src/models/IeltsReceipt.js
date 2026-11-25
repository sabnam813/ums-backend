const mongoose = require('mongoose');
const ieltsReceiptSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestPrepRecord',
    required: true,
    unique: true
  },
  testType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestType',
    required: true
  },
  candidateName: {
    type: String,
    trim: true,
    default: ''
  },
  referenceNumber: {
    type: String,
    trim: true,
    default: ''
  },
  passportNo: {
    type: String,
    trim: true,
    default: ''
  },
  examDate: {
    type: Date,
    required: true
  },
  test: {
    type: String,
    trim: true,
    default: ''
  },
  type: {
    type: String,
    trim: true,
    default: ''
  },
  module: {
    type: String,
    trim: true,
    default: ''
  },
  place: {
    type: String,
    trim: true,
    default: ''
  },
  quotedPrice: {
    type: Number,
    default: 0
  },
  collectedPrice: {
    type: Number,
    default: 0
  },
  margin: {
    type: Number,
    default: 0
  },
  associates: {
    type: String,
    trim: true,
    default: ''
  },
  paidBy: {
    type: String,
    trim: true,
    default: ''
  },
  remarks: {
    type: String,
    trim: true,
    default: ''
  },
  receiptWrittenDate: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
ieltsReceiptSchema.index({
  testType: 1,
  examDate: -1
});
ieltsReceiptSchema.pre('save', function computeMargin(next) {
  this.margin = Number(this.collectedPrice || 0) - Number(this.quotedPrice || 0);
  next();
});
module.exports = mongoose.model('IeltsReceipt', ieltsReceiptSchema);
