const mongoose = require('mongoose');

const REMINDER_LEAD_MS = 30 * 60 * 1000;

const studentFollowUpSchema = new mongoose.Schema({
  application: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
    default: null
  },
  isStandalone: {
    type: Boolean,
    default: false
  },
  chainRoot: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudentFollowUp',
    default: null
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: true
  },

  studentName: {
    type: String,
    trim: true,
    default: ''
  },
  referredBy: {
    type: String,
    trim: true,
    default: ''
  },
  providerName: {
    type: String,
    trim: true,
    default: ''
  },

  scheduledAt: {
    type: Date,
    required: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  method: {
    type: String,
    enum: ['call', 'whatsapp', 'email', 'in_person', 'sms', 'other'],
    default: 'call'
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'no_response', 'cancelled'],
    default: 'pending'
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  plannedNotes: {
    type: String,
    trim: true,
    default: ''
  },

  completedAt: {
    type: Date,
    default: null
  },
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  previousFollowUp: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudentFollowUp',
    default: null
  },
  nextFollowUp: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudentFollowUp',
    default: null
  },

  remindAt: {
    type: Date,
    default: null
  },
  reminderSentAt: {
    type: Date,
    default: null
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

studentFollowUpSchema.pre('validate', function preValidate(next) {
  if (this.scheduledAt) {
    const derived = new Date(this.scheduledAt.getTime() - REMINDER_LEAD_MS);
    if (!this.remindAt || this.isModified('scheduledAt')) {
      this.remindAt = derived;
    }
  }
  next();
});

studentFollowUpSchema.index({ application: 1, scheduledAt: -1 });
studentFollowUpSchema.index({ status: 1, scheduledAt: 1 });
studentFollowUpSchema.index({ assignedTo: 1, status: 1, scheduledAt: 1 });
studentFollowUpSchema.index({ country: 1, status: 1, scheduledAt: 1 });
studentFollowUpSchema.index({ status: 1, remindAt: 1 });
studentFollowUpSchema.index({ studentName: 1 });
studentFollowUpSchema.index({ isStandalone: 1, chainRoot: 1 });

module.exports = mongoose.model('StudentFollowUp', studentFollowUpSchema);
module.exports.REMINDER_LEAD_MS = REMINDER_LEAD_MS;
