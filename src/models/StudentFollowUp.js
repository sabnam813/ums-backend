const mongoose = require('mongoose');

const REMINDER_LEAD_MS = 30 * 60 * 1000;

const studentFollowUpSchema = new mongoose.Schema({
  // Optional now — a standalone follow-up (not tied to any application) is
  // allowed. isStandalone/chainRoot exist only to make standalone entries
  // group sensibly in the dashboard the way application-linked ones already
  // do by application id.
  application: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
    default: null
  },
  isStandalone: {
    type: Boolean,
    default: false
  },
  // For a standalone chain (created via Complete & Schedule Next off another
  // standalone entry), points at the first entry in that chain so the whole
  // chain groups together. Null on the root entry itself.
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

  // Display snapshot taken at creation time. Used as a fallback only —
  // live values are populated from the Application when it still exists.
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

  // Date + time in a single UTC field. Never split these.
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

// Keep remindAt derived from scheduledAt so the sweeper never needs to compute it.
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
