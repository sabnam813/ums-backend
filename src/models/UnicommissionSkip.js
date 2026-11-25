const mongoose = require('mongoose');

const unicommissionSkipSchema = new mongoose.Schema({
  application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', required: true, unique: true },
  country: { type: mongoose.Schema.Types.ObjectId, ref: 'Country' }
}, { timestamps: true });

module.exports = mongoose.model('UnicommissionSkip', unicommissionSkipSchema);
