const mongoose = require('mongoose');

const commissionDepartmentSchema = new mongoose.Schema({
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
  university: {
    type: String,
    required: true,
    trim: true,
    maxlength: 300
  },
  channelPartner: {
    type: String,
    trim: true,
    default: '',
    maxlength: 200
  },
  directIndirect: {
    type: String,
    enum: ['Direct', 'Indirect'],
    default: 'Direct'
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

commissionDepartmentSchema.index({ intake: 1, country: 1, order: 1 });
commissionDepartmentSchema.index({ intake: 1, country: 1, university: 1 });

module.exports = mongoose.model('CommissionDepartment', commissionDepartmentSchema);
