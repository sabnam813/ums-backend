const mongoose = require('mongoose');

// Single-document settings for Daily Report, editable by Super Admin.
const dailyReportSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  // Staff may add/edit a report dated within this many days before today.
  editWindowDays: { type: Number, default: 2, min: 0, max: 90 }
}, { timestamps: true });

module.exports = mongoose.model('DailyReportSettings', dailyReportSettingsSchema);
