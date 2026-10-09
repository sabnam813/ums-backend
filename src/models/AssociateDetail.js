const mongoose = require('mongoose');

/**
 * Associate Details — one row per partner consultancy / associate.
 * Columns mirror the "Main File _ Associates Details" Excel sheet exactly
 * (same order, same meaning). Everything except the consultancy name is
 * optional free text, because the sheet itself is not consistent (multiple
 * phone numbers in one cell, several emails in one cell, etc.).
 */
const str = (max = 300) => ({ type: String, trim: true, default: '', maxlength: max });

const associateDetailSchema = new mongoose.Schema({
  sno: { type: Number, default: null },                       // Sno.
  dateOfOnboarding: { type: Date, default: null },            // Date of Onboarding
  // Raw text kept only when the sheet's date can't be read as a real date.
  dateOfOnboardingText: str(60),
  consultancyName: {                                           // Name Of Consultancy
    type: String, required: [true, 'Name of consultancy is required'], trim: true, maxlength: 300
  },
  ownerName: str(200),                                         // Name of Owner/Director
  designation: str(150),                                       // Designation
  oopStatus: str(300),                                         // OOP Status
  ownerContact: str(120),                                      // Contact No. of Owner
  email: str(300),                                             // Email
  address: str(600),                                           // Address
  location: str(150),                                          // Location
  managerName: str(200),                                       // Name of Manager
  managerEmail: str(300),                                      // Email of Manager (secondary email)
  managerContact: str(120),                                    // Contact No. of Manager
  officialPhone: str(120),                                     // Official Phone number
  emailAdmission: str(300),                                    // Email 1 (Admission)
  emailTestRegistration: str(300),                             // Email 2 (Test Registration)
  emailOthers: str(600),                                       // Email 3 (Others)
  website: str(300),                                           // Website
  referredBy: str(200),                                        // Referred by:
  association: str(600),                                       // Association
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

associateDetailSchema.index({ consultancyName: 1 });
associateDetailSchema.index({ sno: 1 });
associateDetailSchema.index({ location: 1 });

module.exports = mongoose.model('AssociateDetail', associateDetailSchema);
