const mongoose = require('mongoose');

const scheduledDiscordMeetReminderSchema = new mongoose.Schema({
  reminderId: { type: String, required: true, unique: true },
  bookingId: String,
  clientName: String,
  clientEmail: String,
  meetingStartISO: String,
  scheduledFor: { type: Date, required: true, index: true },
  meetingLink: String,
  inviteeTimezone: String,
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  errorMessage: String,
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  deliveryDriftMs: Number,
  source: {
    type: String,
    enum: ['calendly', 'manual', 'reschedule', 'sync', 'whatsapp_reminder'],
    default: 'calendly'
  }
}, { timestamps: true });

scheduledDiscordMeetReminderSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model('ScheduledDiscordMeetReminder', scheduledDiscordMeetReminderSchema, 'scheduleddiscordmeetreminders');
