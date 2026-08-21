const mongoose = require('mongoose');
const contactFieldSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['text', 'number', 'email'],
    default: 'text'
  },
  required: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  _id: true
});
const contactGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  fields: {
    type: [contactFieldSchema],
    default: []
  },
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});
module.exports = mongoose.model('ContactGroup', contactGroupSchema);
