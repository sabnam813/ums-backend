const mongoose = require('mongoose');

const trainingScheduleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: 200
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null
  },
  type: {
    type: String,
    trim: true,
    default: 'Meeting',
    maxlength: 60
  },
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String,
    trim: true,
    default: '',
    maxlength: 10
  },
  endTime: {
    type: String,
    trim: true,
    default: '',
    maxlength: 10
  },
  venue: {
    type: String,
    trim: true,
    default: '',
    maxlength: 150
  },
  host: {
    type: String,
    trim: true,
    default: '',
    maxlength: 150
  },
  participants: {
    type: String,
    trim: true,
    default: '',
    maxlength: 300
  },
  mode: {
    type: String,
    enum: ['physical', 'online', 'hybrid'],
    default: 'physical'
  },
  meetingLink: {
    type: String,
    trim: true,
    default: '',
    maxlength: 500
  },
  agenda: {
    type: String,
    trim: true,
    default: '',
    maxlength: 1500
  },
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'cancelled'],
    default: 'scheduled'
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

trainingScheduleSchema.index({ date: -1 });
trainingScheduleSchema.index({ department: 1, date: 1 });
trainingScheduleSchema.index({ status: 1 });

module.exports = mongoose.model('TrainingSchedule', trainingScheduleSchema);
