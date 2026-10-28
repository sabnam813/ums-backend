const mongoose = require('mongoose');

const str = (max = 300) => ({ type: String, trim: true, default: '', maxlength: max });

const unicommissionSchema = new mongoose.Schema({
  country: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
  application: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },

  studentName: { type: String, required: [true, 'Student name is required'], trim: true, maxlength: 200 },
  associate: str(200),
  intake: str(40),
  university: str(300),
  level: str(60),
  course: str(300),
  commissionProvider: str(200),
  studentIdNo: str(100),
  visaGrantedDate: { type: Date, default: null },
  visaGrantedDateText: str(60),

  feeAmount: { type: Number, default: null },
  currency: { type: String, trim: true, uppercase: true, default: '', maxlength: 6 },

  commissionType: { type: String, enum: ['', 'fixed', 'percentage'], default: '' },
  commissionValue: { type: Number, default: null },

  paymentStatus: { type: String, enum: ['Pending', 'Partial', 'Received'], default: 'Pending' },
  remarks: str(1000),

  manualFields: { type: [String], default: [] },
  sourceFlag: { type: String, enum: ['', 'not_granted', 'application_deleted'], default: '' },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

unicommissionSchema.index({ country: 1, createdAt: 1 });
unicommissionSchema.index({ country: 1, visaGrantedDate: -1 });
unicommissionSchema.index(
  { application: 1 },
  { unique: true, partialFilterExpression: { application: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Unicommission', unicommissionSchema);
