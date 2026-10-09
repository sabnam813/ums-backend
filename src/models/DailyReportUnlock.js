const mongoose = require('mongoose');

// A Super Admin-granted exception: lets one person add/edit a report for one
// date that falls outside the normal edit window.
const dailyReportUnlockSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true },
  grantedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

dailyReportUnlockSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyReportUnlock', dailyReportUnlockSchema);
