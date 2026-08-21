const mongoose = require('mongoose');
const testPrepRecordSchema = new mongoose.Schema({
  testType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestType',
    required: true
  },
  candidateName: {
    type: String,
    required: true,
    trim: true
  },
  associates: {
    type: String,
    trim: true,
    default: ''
  },
  date: {
    type: Date
  },
  bookingDate: {
    type: Date
  },
  examDate: {
    type: Date
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
  paymentStatus: {
    type: String,
    trim: true,
    default: ''
  },
  paymentMadeBy: {
    type: String,
    trim: true,
    default: ''
  },
  paymentDate: {
    type: Date
  },
  paymentAmount: {
    type: Number,
    default: 0
  },
  margin: {
    type: Number,
    default: 0
  },
  paymentDateToBC: {
    type: Date
  },
  paidAmountToBC: {
    type: Number,
    default: 0
  },
  remarks: {
    type: String,
    trim: true,
    default: ''
  },
  referenceNumber: {
    type: String,
    trim: true,
    default: ''
  },
  receivedAmount: {
    type: Number,
    default: 0
  },
  cost: {
    type: Number,
    default: 0
  },
  voucher: {
    type: String,
    trim: true,
    default: ''
  },
  expiryDate: {
    type: Date
  },
  duolingoVoucher: {
    type: String,
    trim: true,
    default: ''
  },
  legacyPteVoucher: {
    type: String,
    trim: true,
    default: ''
  },
  legacyVoucherCode: {
    type: String,
    trim: true,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  customFields: {
    type: Map,
    of: String,
    default: {}
  }
}, {
  timestamps: true
});
testPrepRecordSchema.index({
  testType: 1,
  examDate: -1
});
testPrepRecordSchema.index({
  testType: 1,
  bookingDate: -1
});
testPrepRecordSchema.index({
  testType: 1,
  paymentStatus: 1
});
testPrepRecordSchema.index({
  testType: 1,
  duolingoVoucher: 1
});
module.exports = mongoose.model('TestPrepRecord', testPrepRecordSchema);
