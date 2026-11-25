const mongoose = require('mongoose');
const countrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  flag: {
    type: String,
    default: ''
  },
  flagImage: {
    type: String,
    default: ''
  },
  code: {
    type: String,
    trim: true,
    uppercase: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CountryGroup',
    default: null
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});
countrySchema.index({
  group: 1,
  order: 1
});
module.exports = mongoose.model('Country', countrySchema);
