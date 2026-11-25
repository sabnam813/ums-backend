const mongoose = require('mongoose');

const counsellorSchema = new mongoose.Schema({
  associate: { type: String, required: [true, 'Associate is required'], trim: true, maxlength: 300 },
  counsellorName: { type: String, required: [true, 'Counsellor name is required'], trim: true, maxlength: 200 },
  phone: { type: String, trim: true, default: '', maxlength: 120 },
  email: { type: String, trim: true, default: '', maxlength: 300 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

counsellorSchema.index({ associate: 1 });
counsellorSchema.index({ counsellorName: 1 });

module.exports = mongoose.model('Counsellor', counsellorSchema);
