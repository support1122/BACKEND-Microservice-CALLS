const mongoose = require('mongoose');

const bdaAttendanceSchema = new mongoose.Schema({
  attendanceId: { type: String, required: true, unique: true },
  bookingId: { type: String, required: true, index: true },
  bdaEmail: String,
  bdaName: String,
  joinedAt: Date,
  leftAt: Date,
  cumulativeDurationMs: { type: Number, default: 0 },
  durationMs: Number,
  status: {
    type: String,
    enum: ['present', 'absent', 'partial'],
    default: 'absent'
  },
  meetingScheduledStart: Date,
  meetingScheduledEnd: Date,
  notes: String,
  discordNotified: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('BdaAttendance', bdaAttendanceSchema, 'bdaattendances');
