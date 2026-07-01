const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
  country: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
  date: { type: Date, default: Date.now },
  referredBy: { type: String, trim: true },
  name: { type: String, required: true, trim: true },
  
  level: { type: String, trim: true, default: '' },
  course: { type: String, trim: true },
  providerName: { type: String, trim: true },
  initialIntake: { type: String, trim: true },
  deferredIntake: { type: String, trim: true },
  gsSubmission: { type: String, trim: true, default: 'Not Submitted' },

  olRequest: { type: String, trim: true, default: 'Not Requested' },
  offerLetter: { type: String, trim: true, default: 'Not Received' },
  withdraw: { type: String, trim: true, default: 'No' },

  payment: { type: String, trim: true, default: 'Incomplete' },
  coeCas: { type: String, trim: true, default: 'Not Received' },
  savisFee: { type: String, trim: true, default: 'Unpaid' },
  refund: { type: String, trim: true, default: 'Non-Refunded' },

  visaLodgement: { type: Date },
  visaOutcome: { type: String, trim: true, default: '' },
  visaWithdraw: { type: String, trim: true, default: 'No' },

  other: { type: String, trim: true },
  remarks: { type: String, trim: true },
  through: { type: String, trim: true },
  
  customFields: { type: Map, of: String, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

applicationSchema.index({ country: 1, date: -1 });
applicationSchema.index({ country: 1, level: 1 });
applicationSchema.index({ country: 1, offerLetter: 1 });
applicationSchema.index({ country: 1, payment: 1 });
applicationSchema.index({ country: 1, gsSubmission: 1 });
applicationSchema.index({ country: 1, coeCas: 1 });
applicationSchema.index({ country: 1, olRequest: 1 });
applicationSchema.index({ country: 1, visaWithdraw: 1 });

module.exports = mongoose.model('Application', applicationSchema);