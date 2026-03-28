const mongoose = require('mongoose');

const scheduledWhatsAppReminderSchema = new mongoose.Schema({
  reminderId: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  scheduledFor: { type: Date, required: true, index: true },
  meetingTime: String,
  meetingDate: String,
  meetingStartISO: String,
  clientName: String,
  clientEmail: String,
  meetingLink: String,
  rescheduleLink: String,
  timezone: String,
  bookingId: String,
  reminderType: {
    type: String,
    enum: ['5min', '2hour', '24hour', 'noshow'],
    default: '5min'
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  watiResponse: mongoose.Schema.Types.Mixed,
  errorMessage: String,
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  deliveryDriftMs: Number,
  source: {
    type: String,
    enum: ['calendly', 'manual', 'reschedule', 'debug'],
    default: 'calendly'
  }
}, { timestamps: true });

scheduledWhatsAppReminderSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model('ScheduledWhatsAppReminder', scheduledWhatsAppReminderSchema, 'scheduledwhatsappreminders');
