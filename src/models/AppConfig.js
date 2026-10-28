const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  lists: { type: mongoose.Schema.Types.Mixed, default: {} },
  fiscalYears: { type: [{ _id: false, label: String, from: String, to: String }], default: undefined },
  modules: { type: mongoose.Schema.Types.Mixed, default: {} },
  commissionPinHash: { type: String, default: '', select: false },
  commissionPinVersion: { type: Number, default: 0 },
  commissionPinUpdatedAt: { type: Date, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('AppConfig', schema);
