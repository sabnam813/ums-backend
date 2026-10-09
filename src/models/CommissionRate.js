const mongoose = require('mongoose');

// Associate and Shareholder are the same shape — a per-university commission
// rate that's genuinely free text ("12% net tuition per year", "$2,400
// onetime", tiered-by-headcount language, etc.) — real commission terms are
// too irregular to force into a numeric field, so undergraduate/postgraduate
// are plain text, not currency amounts.
const commissionRateSchema = new mongoose.Schema({
  intake: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CommissionIntake',
    required: true
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: true
  },
  section: {
    type: String,
    enum: ['associate', 'shareholder'],
    required: true
  },
  university: {
    type: String,
    required: true,
    trim: true,
    maxlength: 300
  },
  undergraduate: {
    type: String,
    trim: true,
    default: '',
    maxlength: 2000
  },
  postgraduate: {
    type: String,
    trim: true,
    default: '',
    maxlength: 2000
  },
  remarks: {
    type: String,
    trim: true,
    default: '',
    maxlength: 1000
  },
  // Preserves the row order from the source document/import — these lists
  // are read as a reference table, not sorted alphabetically by staff.
  order: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

commissionRateSchema.index({ intake: 1, country: 1, section: 1, order: 1 });
commissionRateSchema.index({ intake: 1, country: 1, section: 1, university: 1 });

module.exports = mongoose.model('CommissionRate', commissionRateSchema);
