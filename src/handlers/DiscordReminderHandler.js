'use strict';

const ScheduledDiscordMeetReminder = require('../models/ScheduledDiscordMeetReminder');
const ReminderError = require('../models/ReminderError');
const { minutesBefore, formatMeetingTime } = require('../utils/timezone');
const {
  DISCORD_MEET_REMINDER_OFFSET_MINUTES,
  REMINDER_DRIFT_WARN_MS,
} = require('../config/env');

class DiscordReminderHandler {
  /**
   * @param {Object} deps
   * @param {Object} deps.discordService
   * @param {Object} deps.logger
   */
  constructor({ discordService, logger }) {
    this._discord = discordService;
    this._log = logger.child({ component: 'DiscordReminderHandler' });
  }

  /* ------------------------------------------------------------------ */
  /*  Schedule                                                          */
  /* ------------------------------------------------------------------ */

  async schedule({
    bookingId,
    clientName,
    clientEmail,
    meetingStartISO,
    meetingLink,
    inviteeTimezone,
    source = 'calendly',
  }) {
    const scheduledFor = minutesBefore(meetingStartISO, DISCORD_MEET_REMINDER_OFFSET_MINUTES);
    const reminderId = `discord_${bookingId}_${Date.now()}`;

    const doc = await ScheduledDiscordMeetReminder.create({
      reminderId,
      bookingId,
      clientName,
      clientEmail,
      meetingStartISO,
      scheduledFor,
      meetingLink,
      inviteeTimezone,
      status: 'pending',
      source,
    });

    this._log.info({ reminderId, bookingId, scheduledFor }, 'Discord reminder scheduled');
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /*  Execute                                                           */
  /* ------------------------------------------------------------------ */

  async execute(reminderDoc) {
    const { reminderId, bookingId } = reminderDoc;
    this._log.info({ reminderId }, 'Executing Discord reminder');

    // Atomic claim
    const claimed = await ScheduledDiscordMeetReminder.findOneAndUpdate(
      { reminderId, status: 'pending' },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { new: true },
    );

    if (!claimed) {
      this._log.warn({ reminderId }, 'Discord reminder already processed or cancelled, skipping');
      return;
    }

    const deliveryDriftMs = Date.now() - new Date(claimed.scheduledFor).getTime();
    const formattedTime = formatMeetingTime(
      claimed.meetingStartISO,
      claimed.inviteeTimezone || 'Asia/Kolkata',
    );

    try {
      const minutesUntil = Math.max(0, Math.round((new Date(claimed.meetingStartISO).getTime() - Date.now()) / 60000));
      await this._discord.sendMeetReminder({
        clientName: claimed.clientName,
        meetingTime: formattedTime,
        meetingLink: claimed.meetingLink,
        minutesUntil,
      });

      await ScheduledDiscordMeetReminder.findOneAndUpdate(
        { reminderId },
        {
          $set: {
            status: 'completed',
            deliveryDriftMs,
          },
        },
      );

      if (deliveryDriftMs > REMINDER_DRIFT_WARN_MS) {
        this._log.warn({ reminderId, deliveryDriftMs }, 'Discord delivery drift exceeds threshold');
      }

      this._log.info({ reminderId, deliveryDriftMs }, 'Discord reminder completed');
    } catch (err) {
      this._log.error({ err, reminderId }, 'Discord reminder execution failed');

      if (claimed.attempts < claimed.maxAttempts) {
        await ScheduledDiscordMeetReminder.findOneAndUpdate(
          { reminderId },
          { $set: { status: 'pending', errorMessage: err.message } },
        );
        this._log.info({ reminderId, attempt: claimed.attempts }, 'Discord reminder queued for retry');
      } else {
        await ScheduledDiscordMeetReminder.findOneAndUpdate(
          { reminderId },
          { $set: { status: 'failed', errorMessage: err.message, deliveryDriftMs } },
        );

        await ReminderError.create({
          bookingId,
          clientEmail: claimed.clientEmail,
          category: 'discord',
          severity: 'error',
          message: `Discord reminder failed after ${claimed.maxAttempts} attempts: ${err.message}`,
          details: { reminderId, attempts: claimed.attempts },
          stack: err.stack,
          source: 'DiscordReminderHandler.execute',
        });

        this._log.error({ reminderId }, 'Discord reminder permanently failed');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Cancel                                                            */
  /* ------------------------------------------------------------------ */

  async cancel(reminderId) {
    await ScheduledDiscordMeetReminder.findOneAndUpdate(
      { reminderId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ reminderId }, 'Discord reminder cancelled');
  }

  async cancelForBooking(bookingId) {
    const result = await ScheduledDiscordMeetReminder.updateMany(
      { bookingId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ bookingId, cancelled: result.modifiedCount }, 'Discord reminders cancelled for booking');
  }
}

module.exports = DiscordReminderHandler;
