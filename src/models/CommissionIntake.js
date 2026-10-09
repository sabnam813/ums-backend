const mongoose = require('mongoose');

const commissionIntakeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Every existing country appears automatically inside every intake — the
// "country folder" is a UI concept, not a stored document — so the only
// thing that needs to stay unique here is the intake name itself.
commissionIntakeSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('CommissionIntake', commissionIntakeSchema);
