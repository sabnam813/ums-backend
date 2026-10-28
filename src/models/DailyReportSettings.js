const mongoose = require('mongoose');

const dailyReportSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  editWindowDays: { type: Number, default: 2, min: 0, max: 90 }
}, { timestamps: true });

module.exports = mongoose.model('DailyReportSettings', dailyReportSettingsSchema);
