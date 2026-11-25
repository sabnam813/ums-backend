const mongoose = require('mongoose');

const unicommissionSettingSchema = new mongoose.Schema({
  country: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true, unique: true },
  currency: { type: String, trim: true, uppercase: true, default: '', maxlength: 6 },
  commissionType: { type: String, enum: ['fixed', 'percentage'], default: 'percentage' },
  commissionValue: { type: Number, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('UnicommissionSetting', unicommissionSettingSchema);
