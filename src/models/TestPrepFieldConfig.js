const mongoose = require('mongoose');
const testPrepFieldConfigSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['options', 'custom'],
    required: true
  },
  fieldKey: {
    type: String,
    trim: true
  },
  key: {
    type: String,
    trim: true
  },
  label: {
    type: String,
    trim: true,
    required: true
  },
  type: {
    type: String,
    enum: ['text', 'date', 'dropdown'],
    default: 'text'
  },
  options: [{
    type: String,
    trim: true
  }],
  removedDefaults: [{
    type: String,
    trim: true
  }],
  required: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    default: 0
  },
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});
testPrepFieldConfigSchema.index({
  kind: 1,
  fieldKey: 1
});
testPrepFieldConfigSchema.index({
  kind: 1,
  key: 1
}, {
  unique: true,
  partialFilterExpression: {
    kind: 'custom'
  }
});
module.exports = mongoose.model('TestPrepFieldConfig', testPrepFieldConfigSchema);
