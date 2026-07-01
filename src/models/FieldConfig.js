const mongoose = require('mongoose');

const fieldConfigSchema = new mongoose.Schema({
  kind: { type: String, enum: ['options', 'custom'], required: true },
  fieldKey: { type: String, trim: true },
  key: { type: String, trim: true },
  label: { type: String, trim: true, required: true },
  type: {
    type: String,
    enum: ['text', 'textarea', 'number', 'date', 'dropdown'],
    default: 'text',
  },
  
  validationType: {
    type: String,
    enum: ['any', 'number_only', 'word_only', null],
    default: null,
  },
  options: [{ type: String, trim: true }],
  required: { type: Boolean, default: false },
  section: { type: String, default: 'Additional Information' },
  order: { type: Number, default: 0 },
  afterFieldId: { type: String, default: 'last' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

fieldConfigSchema.index({ kind: 1, fieldKey: 1 });
fieldConfigSchema.index({ kind: 1, key: 1 }, { unique: true, partialFilterExpression: { kind: 'custom' } });

module.exports = mongoose.model('FieldConfig', fieldConfigSchema);
