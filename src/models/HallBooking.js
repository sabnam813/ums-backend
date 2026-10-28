const mongoose = require('mongoose');

const hallBookingSchema = new mongoose.Schema({
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    default: null
  },
  eventType: {
    type: String,
    enum: ['country', 'general'],
    default: 'country'
  },
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
