const mongoose = require('mongoose');

const NEPALI_MONTHS = ['Shrawan', 'Bhadra', 'Ashoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra', 'Baishakh', 'Jestha', 'Ashadh'];
const PERIOD_TYPES = ['monthly', 'weekly'];

const testPrepAchievementTargetSchema = new mongoose.Schema({
  periodType: {
    type: String,
    required: true,
    enum: PERIOD_TYPES,
    default: 'monthly'
  },
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
  weekNumber: {
    type: Number,
    min: 1,
    max: 12,
    default: null
  },
  fromDate: {
    type: Date,
    required: true
  },
  toDate: {
    type: Date,
    required: true
  },
  testType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TestType',
    required: true
  },
  target: {
    type: Number,
    default: 0,
    min: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

testPrepAchievementTargetSchema.index({
  fiscalYear: 1,
  nepaliMonth: 1,
  testType: 1,
  periodType: 1,
  weekNumber: 1
}, {
  unique: true
});

testPrepAchievementTargetSchema.statics.NEPALI_MONTHS = NEPALI_MONTHS;
testPrepAchievementTargetSchema.statics.PERIOD_TYPES = PERIOD_TYPES;

module.exports = mongoose.model('TestPrepAchievementTarget', testPrepAchievementTargetSchema);
