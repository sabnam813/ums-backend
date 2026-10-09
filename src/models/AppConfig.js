const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  lists: { type: mongoose.Schema.Types.Mixed, default: {} },
  fiscalYears: { type: [{ _id: false, label: String, from: String, to: String }], default: undefined },
  modules: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('AppConfig', schema);
