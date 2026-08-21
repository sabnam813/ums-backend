const mongoose = require('mongoose');

const diarySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: 150
  },
  post: {
    type: String,
    trim: true,
    default: '',
    maxlength: 150
  },
  mobile: {
    type: String,
    trim: true,
    default: '',
    maxlength: 40
  },
  remarks: {
    type: String,
    trim: true,
    default: '',
    maxlength: 2000
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

diarySchema.index({ name: 1 });
diarySchema.index({ mobile: 1 });

module.exports = mongoose.model('Diary', diarySchema);
