'use strict';

const ScheduledWhatsAppReminder = require('../models/ScheduledWhatsAppReminder');
const ReminderError = require('../models/ReminderError');
const { minutesBefore, formatMeetingTime } = require('../utils/timezone');
const { REMINDER_DRIFT_WARN_MS } = require('../config/env');

const REMINDER_OFFSETS = {
  '5min': 5,
  '2hour': 120,
  '24hour': 1440,
  'noshow': 0,
};

// All reminder types use the same WATI template (matching parent app)
const TEMPLATE_MAP = {
  '5min': 'flashfire_appointment_reminder',
  '2hour': 'flashfire_appointment_reminder',
  '24hour': 'flashfire_appointment_reminder',
  'noshow': 'flashfire_appointment_reminder',
};

class WhatsAppHandler {
  /**
   * @param {Object} deps
   * @param {Object} deps.watiService
   * @param {Object} deps.discordService
   * @param {Object} deps.logger
   */
  constructor({ watiService, discordService, logger }) {
    this._wati = watiService;
    this._discord = discordService;
    this._log = logger.child({ component: 'WhatsAppHandler' });
  }

  /* ------------------------------------------------------------------ */
  /*  Schedule                                                          */
  /* ------------------------------------------------------------------ */

  async schedule({
    phoneNumber,
    meetingStartISO,
    clientName,
    clientEmail,
    meetingLink,
    rescheduleLink,
    timezone,
    bookingId,
    reminderType = '5min',
    source = 'calendly',
  }) {
    const offsetMinutes = REMINDER_OFFSETS[reminderType];
    if (offsetMinutes === undefined) {
      throw new Error(`Unknown reminderType: ${reminderType}`);
    }

    const scheduledFor =
      reminderType === 'noshow'
        ? new Date()
        : minutesBefore(meetingStartISO, offsetMinutes);

    if (!scheduledFor) {
      this._log.warn({ bookingId, meetingStartISO, reminderType }, 'Invalid meeting start time, skipping WA reminder');
      return null;
    }

    const reminderId = `wa_${bookingId}_${reminderType}_${Date.now()}`;

    const doc = await ScheduledWhatsAppReminder.create({
      reminderId,
      phoneNumber,
      scheduledFor,
      meetingStartISO,
      clientName,
      clientEmail,
      meetingLink,
      rescheduleLink,
      timezone,
      bookingId,
      reminderType,
      status: 'pending',
      source,
    });

    this._log.info({ reminderId, bookingId, reminderType, scheduledFor }, 'WA reminder scheduled');
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /*  Execute                                                           */
  /* ------------------------------------------------------------------ */

  async execute(reminderDoc) {
    const { reminderId, bookingId } = reminderDoc;
    this._log.info({ reminderId }, 'Executing WA reminder');

    // Atomic claim
    const claimed = await ScheduledWhatsAppReminder.findOneAndUpdate(
      { reminderId, status: 'pending' },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { new: true },
    );

    if (!claimed) {
      this._log.warn({ reminderId }, 'WA reminder already processed or cancelled, skipping');
      return;
    }

    const deliveryDriftMs = Date.now() - new Date(claimed.scheduledFor).getTime();
    const formattedTime = formatMeetingTime(
      claimed.meetingStartISO,
      claimed.timezone || 'Asia/Kolkata',
    );

    // Parameters match parent app: {{1}}=name, {{2}}=date, {{3}}=time+tz, {{4}}=link, {{5}}=reschedule
    const meetingDate = claimed.meetingStartISO
      ? new Date(claimed.meetingStartISO).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '';
    const tzAbbr = claimed.timezone || 'IST';
    const templateParams = [
      claimed.clientName || 'Valued Client',                    // {{1}}
      meetingDate,                                               // {{2}}
      `${formattedTime} ${tzAbbr}`,                             // {{3}}
      claimed.meetingLink || 'Not Provided',                     // {{4}}
      claimed.rescheduleLink || 'https://calendly.com',          // {{5}}
    ];

    const templateName = TEMPLATE_MAP[claimed.reminderType] || 'meeting_reminder_5min';

    try {
      const watiResponse = await this._wati.sendTemplateMessage({
        phoneNumber: claimed.phoneNumber,
        templateName,
        parameters: templateParams,
      });

      await ScheduledWhatsAppReminder.findOneAndUpdate(
        { reminderId },
        {
          $set: {
            status: 'completed',
            watiResponse,
            deliveryDriftMs,
          },
        },
      );

      if (deliveryDriftMs > REMINDER_DRIFT_WARN_MS) {
        this._log.warn({ reminderId, deliveryDriftMs }, 'WA delivery drift exceeds threshold');
      }

      this._log.info({ reminderId, deliveryDriftMs }, 'WA reminder completed');
    } catch (err) {
      this._log.error({ err, reminderId }, 'WA reminder execution failed');

      if (claimed.attempts < claimed.maxAttempts) {
        await ScheduledWhatsAppReminder.findOneAndUpdate(
          { reminderId },
          { $set: { status: 'pending', errorMessage: err.message } },
        );
        this._log.info({ reminderId, attempt: claimed.attempts }, 'WA reminder queued for retry');
      } else {
        await ScheduledWhatsAppReminder.findOneAndUpdate(
          { reminderId },
          { $set: { status: 'failed', errorMessage: err.message, deliveryDriftMs } },
        );

        await ReminderError.create({
          bookingId,
          clientPhone: claimed.phoneNumber,
          clientEmail: claimed.clientEmail,
          category: 'whatsapp',
          severity: 'error',
          message: `WA reminder failed after ${claimed.maxAttempts} attempts: ${err.message}`,
          details: { reminderId, reminderType: claimed.reminderType, attempts: claimed.attempts },
          stack: err.stack,
          source: 'WhatsAppHandler.execute',
        });

        this._log.error({ reminderId }, 'WA reminder permanently failed');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Cancel                                                            */
  /* ------------------------------------------------------------------ */

  async cancel(reminderId) {
    await ScheduledWhatsAppReminder.findOneAndUpdate(
      { reminderId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ reminderId }, 'WA reminder cancelled');
  }

  async cancelForBooking(bookingId) {
    const result = await ScheduledWhatsAppReminder.updateMany(
      { bookingId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ bookingId, cancelled: result.modifiedCount }, 'WA reminders cancelled for booking');
  }
}

module.exports = WhatsAppHandler;
