const mongoose = require('mongoose');

const reminderErrorSchema = new mongoose.Schema({
  bookingId: String,
  clientEmail: String,
  clientPhone: String,
  category: {
    type: String,
    enum: ['call', 'whatsapp', 'discord', 'bda', 'scheduler'],
    required: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    default: 'error'
  },
  message: { type: String, required: true },
  details: mongoose.Schema.Types.Mixed,
  stack: String,
  source: String,
  resolved: { type: Boolean, default: false },
  resolvedAt: Date,
  resolvedBy: String
}, { timestamps: true });

reminderErrorSchema.index({ category: 1, severity: 1 });

module.exports = mongoose.model('ReminderError', reminderErrorSchema, 'remindererrors');
