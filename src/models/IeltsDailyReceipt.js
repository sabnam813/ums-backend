const mongoose = require('mongoose');

const ieltsDailyReceiptSchema = new mongoose.Schema({
  testType: { type: mongoose.Schema.Types.ObjectId, ref: 'TestType', required: true },
  receiptDate: { type: Date, required: true },
  overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  manualRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
  summaryRows: { type: mongoose.Schema.Types.Mixed, default: {} },
  summaryExtra: { type: [mongoose.Schema.Types.Mixed], default: [] },
  difference: { type: String, default: '' },
  paidOn: { type: Date },
  preparedBy: { type: String, trim: true, default: '' },
  checkedBy: { type: String, trim: true, default: '' },
  approvedBy: { type: String, trim: true, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

ieltsDailyReceiptSchema.index({ testType: 1, receiptDate: 1 }, { unique: true });

module.exports = mongoose.model('IeltsDailyReceipt', ieltsDailyReceiptSchema);
