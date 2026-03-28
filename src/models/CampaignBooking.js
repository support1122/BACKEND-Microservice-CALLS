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
  claimedBy: String
}, { timestamps: true });

module.exports = mongoose.model('CampaignBooking', campaignBookingSchema, 'campaignbookings');
