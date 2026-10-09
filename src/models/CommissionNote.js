const mongoose = require('mongoose');

// The free-text policy note that sits above/below a commission table — e.g.
// "Commission payable to the Promoters/Shareholders shall be 90% of the
// rates specified below" — differs per country, so it has to be editable
// rather than hardcoded. One doc per (intake, country, section).
const commissionNoteSchema = new mongoose.Schema({
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
    enum: ['associate', 'shareholder', 'department'],
    required: true
  },
  headerNote: {
    type: String,
    trim: true,
    default: '',
    maxlength: 4000
  },
  footerNote: {
    type: String,
    trim: true,
    default: '',
    maxlength: 4000
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

commissionNoteSchema.index({ intake: 1, country: 1, section: 1 }, { unique: true });

module.exports = mongoose.model('CommissionNote', commissionNoteSchema);
