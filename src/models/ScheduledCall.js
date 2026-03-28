const mongoose = require('mongoose');

const scheduledCallSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  scheduledFor: { type: Date, required: true, index: true },
  meetingTime: String,
  meetingDate: String,
  meetingStartISO: String,
  inviteeName: String,
  inviteeEmail: String,
  meetingLink: String,
  rescheduleLink: String,
  inviteeTimezone: String,
  bookingId: String,
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'skipped'],
    default: 'pending',
    index: true
  },
  twilioCallSid: String,
  errorMessage: String,
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  statusHistory: [{
    status: String,
    answeredBy: String,
    timestamp: Date,
    duration: Number
  }],
  deliveryDriftMs: Number,
  source: {
    type: String,
    enum: ['calendly', 'manual', 'campaign', 'reschedule', 'debug'],
    default: 'calendly'
  }
}, { timestamps: true });

scheduledCallSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model('ScheduledCall', scheduledCallSchema, 'scheduledcalls');
