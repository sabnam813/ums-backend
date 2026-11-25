const mongoose = require('mongoose');

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
