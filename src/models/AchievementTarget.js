const mongoose = require('mongoose');
const NEPALI_MONTHS = ['Shrawan', 'Bhadra', 'Ashoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra', 'Baishakh', 'Jestha', 'Ashadh'];
const STAGES = ['inquiry', 'wip', 'visaLodge', 'visa'];
const stageTargetsSchema = new mongoose.Schema({
  inquiry: {
    type: Number,
    default: 0,
    min: 0
  },
  wip: {
    type: Number,
    default: 0,
    min: 0
  },
  visaLodge: {
    type: Number,
    default: 0,
    min: 0
  },
  visa: {
    type: Number,
    default: 0,
    min: 0
  }
}, {
  _id: false
});
const achievementTargetSchema = new mongoose.Schema({
  fiscalYear: {
    type: String,
    required: true,
    trim: true
  },
  nepaliMonth: {
    type: String,
    required: true,
    enum: NEPALI_MONTHS
  },
  fromDate: {
    type: Date,
    required: true
  },
  toDate: {
    type: Date,
    required: true
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: true
  },
  targets: {
    type: stageTargetsSchema,
    default: () => ({})
  },
  target: {
    type: Number,
    min: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
achievementTargetSchema.index({
  fiscalYear: 1,
  nepaliMonth: 1,
  country: 1
}, {
  unique: true
});
achievementTargetSchema.statics.NEPALI_MONTHS = NEPALI_MONTHS;
achievementTargetSchema.statics.STAGES = STAGES;
module.exports = mongoose.model('AchievementTarget', achievementTargetSchema);
