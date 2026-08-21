const mongoose = require('mongoose');
const TRASH_TTL_DAYS = 60;
const trashSchema = new mongoose.Schema({
  model: {
    type: String,
    required: true,
    enum: ['Application', 'Inquiry', 'Country', 'User', 'FieldConfig', 'TestType', 'TestPrepRecord', 'TestPrepFieldConfig', 'Contact', 'ContactGroup', 'CountryGroup', 'Portal', 'Diary']
  },
  originalId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  deletedByName: {
    type: String,
    trim: true,
    default: ''
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  expiresAt: {
    type: Date
  }
}, {
  timestamps: true
});
trashSchema.index({
  model: 1,
  createdAt: -1
});
trashSchema.index({
  deletedBy: 1
});
trashSchema.index({
  expiresAt: 1
}, {
  expireAfterSeconds: 0
});
trashSchema.statics.TTL_DAYS = TRASH_TTL_DAYS;
module.exports = mongoose.model('Trash', trashSchema);
