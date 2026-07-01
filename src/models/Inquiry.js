const mongoose = require('mongoose');

const inquirySchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  referredBy: { type: String, trim: true, default: '' },
  applicantName: { type: String, required: true, trim: true },
  country: { type: String, trim: true, default: '' },
  level: { type: String, trim: true, default: '' },
  stage: { type: String, trim: true, default: '' },
  mode: { type: String, trim: true, default: '' },
  respondedBy: { type: String, trim: true, default: '' },
  emailType: { type: String, trim: true, default: '' },
  remarks: { type: String, trim: true, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

inquirySchema.index({ date: -1 });
inquirySchema.index({ applicantName: 1 });

module.exports = mongoose.model('Inquiry', inquirySchema);
