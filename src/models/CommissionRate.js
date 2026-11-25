const mongoose = require('mongoose');

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
  partner: {
    type: String,
    trim: true,
    default: '',
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
