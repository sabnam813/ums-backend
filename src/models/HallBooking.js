const mongoose = require('mongoose');

const hallBookingSchema = new mongoose.Schema({
  // Optional now — a "general" event (see eventType) isn't tied to a country.
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    default: null
  },
  // 'country' = the original per-country visitor booking. 'general' = an
  // internal/other event with no country attached (e.g. "Board meeting").
  eventType: {
    type: String,
    enum: ['country', 'general'],
    default: 'country'
  },
  // Only used when eventType 'general' — the free-text name of the event.
  eventTitle: {
    type: String,
    trim: true,
    default: '',
    maxlength: 200
  },
  date: {
    type: Date,
    required: true
  },
  hall: {
    type: String,
    required: [true, 'Hall / room is required'],
    trim: true,
    maxlength: 100
  },
  time: {
    type: String,
    trim: true,
    default: '',
    maxlength: 100
  },
  institution: {
    type: String,
    trim: true,
    default: '',
    maxlength: 200
  },
  representativeName: {
    type: String,
    trim: true,
    default: '',
    maxlength: 150
  },
  designation: {
    type: String,
    trim: true,
    default: '',
    maxlength: 150
  },
  remarks: {
    type: String,
    trim: true,
    default: '',
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'cancelled'],
    default: 'scheduled'
  },
  // Who can see this booking. 'everyone' (default, matches old behaviour) —
  // every user with hallBooking view access sees it. 'specific' — only the
  // users listed in allowedUsers (plus the creator and super_admin). 'private'
  // — only the creator and super_admin.
  visibility: {
    mode: {
      type: String,
      enum: ['everyone', 'specific', 'private'],
      default: 'everyone'
    },
    allowedUsers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }]
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

hallBookingSchema.index({ country: 1, date: -1 });
hallBookingSchema.index({ hall: 1, date: 1 });
hallBookingSchema.index({ status: 1 });

module.exports = mongoose.model('HallBooking', hallBookingSchema);
