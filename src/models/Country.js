const mongoose = require('mongoose');

const countrySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  flag: { type: String, default: '' },          
  flagImage: { type: String, default: '' },      
  code: { type: String, trim: true, uppercase: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

module.exports = mongoose.model('Country', countrySchema);
