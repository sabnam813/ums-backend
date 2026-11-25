const mongoose = require('mongoose');

const tpMarginSchema = new mongoose.Schema({
  date: { type: Date, required: [true, 'Date is required'] },
  particular: { type: String, required: [true, 'Particulars is required'], trim: true, maxlength: 120 },
  price: { type: Number, default: 0 },
  totalMargin: { type: Number, default: 0 },
  associateMargin: { type: Number, default: 0 },
  ucaMargin: { type: Number, default: 0 },
  remarks: { type: String, trim: true, default: '', maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

tpMarginSchema.index({ date: 1 });
tpMarginSchema.index({ particular: 1 });

module.exports = mongoose.model('TPMargin', tpMarginSchema);
