const mongoose = require('mongoose');

const str = (max = 300) => ({ type: String, trim: true, default: '', maxlength: max });

const associateDetailSchema = new mongoose.Schema({
  sno: { type: Number, default: null },
  dateOfOnboarding: { type: Date, default: null },
  dateOfOnboardingText: str(60),
  consultancyName: {
    type: String, required: [true, 'Name of consultancy is required'], trim: true, maxlength: 300
  },
  owners: {
    type: [new mongoose.Schema({
      name: str(200),
      designation: str(150),
      contact: str(120)
    }, { _id: false })],
    default: []
  },
  ownerName: str(2000),
  designation: str(1500),
  ownerContact: str(1500),
  email: str(300),
  address: str(600),
  location: str(150),
  managerName: str(200),
  managerEmail: str(300),
  managerContact: str(120),
  officialPhone: str(120),
  emailAdmission: str(300),
  emailTestRegistration: str(300),
  emailOthers: str(600),
  website: str(300),
  referredBy: str(200),
  association: str(600),
  status: { type: String, enum: ['Shareholder', 'Associate', 'Terminated', 'Closed'], default: 'Associate' },
  aliases: { type: [String], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

associateDetailSchema.index({ consultancyName: 1 });
associateDetailSchema.index({ sno: 1 });
associateDetailSchema.index({ location: 1 });
associateDetailSchema.index({ status: 1 });

module.exports = mongoose.model('AssociateDetail', associateDetailSchema);
