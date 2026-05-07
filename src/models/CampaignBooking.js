const mongoose = require('mongoose');

const campaignBookingSchema = new mongoose.Schema({
  bookingId: { type: String, unique: true },
  campaignId: String,
  clientName: String,
  clientEmail: String,
  clientPhone: String,
  scheduledEventStartTime: Date,
  scheduledEventEndTime: Date,
  inviteeTimezone: String,
  bookingStatus: {
    type: String,
    enum: ['not-scheduled', 'scheduled', 'completed', 'canceled', 'rescheduled', 'no-show', 'paid']
  },
  calendlyEventUri: String,
  calendlyMeetLink: String,
  googleMeetCode: String,
  claimedBy: String,
  // Single-winner dispatch flags. Atomic claim via { field: null } → { $set: { field: now } }.
  bdaDiscordReminderSentAt: { type: Date, default: null, index: true },
  bdaDiscordReminderSentBy: { type: String, default: null },
  whatsappReminderSentAt: { type: Date, default: null },
  whatsappReminderSentBy: { type: String, default: null },
  bdaCallPlacedAt: { type: Date, default: null },
  bdaCallPlacedBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('CampaignBooking', campaignBookingSchema, 'campaignbookings');
