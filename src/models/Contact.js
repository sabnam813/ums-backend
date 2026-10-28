const mongoose = require('mongoose');
const contactSchema = new mongoose.Schema({
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContactGroup',
    required: true
  },
  data: {
    type: Map,
    of: String,
    default: {}
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});
contactSchema.index({
  group: 1,
  createdAt: -1
});
module.exports = mongoose.model('Contact', contactSchema);
