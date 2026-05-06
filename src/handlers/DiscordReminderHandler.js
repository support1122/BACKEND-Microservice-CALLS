'use strict';

const ScheduledDiscordMeetReminder = require('../models/ScheduledDiscordMeetReminder');
const ReminderError = require('../models/ReminderError');
const CampaignBooking = require('../models/CampaignBooking');
const { minutesBefore, formatMeetingTime } = require('../utils/timezone');
const {
  DISCORD_MEET_REMINDER_OFFSET_MINUTES,
  REMINDER_DRIFT_WARN_MS,
} = require('../config/env');

// Treat null/empty/Unknown variants as missing
function isUsableTime(v) {
  return (
    v != null &&
    v !== '' &&
    v !== 'Unknown' &&
    !String(v).startsWith('Unknown') &&
    v !== 'undefined'
  );
}

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
    if (!scheduledFor) {
      this._log.warn({ bookingId, meetingStartISO }, 'Invalid meeting start time, skipping Discord reminder');
      return null;
    }
    const reminderId = `discord_${bookingId}_${Date.now()}`;

    // Pre-compute formatted times NOW so the send path never has to recompute
    // and never prints "Unknown" for legitimate bookings.
    const precomputedClientTime = formatMeetingTime(meetingStartISO, inviteeTimezone || 'Asia/Kolkata');
    const precomputedIndiaTime = formatMeetingTime(meetingStartISO, 'Asia/Kolkata');

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
      precomputedClientTime,
      precomputedIndiaTime,
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
      { $set: { status: 'processing', processedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true },
    );

    if (!claimed) {
      this._log.warn({ reminderId }, 'Discord reminder already processed or cancelled, skipping');
      return;
    }

    // Fallback dedupe: if a sibling row for the same booking+meeting already completed
    // (i.e. main backend dispatched), cancel this one and skip.
    if (claimed.bookingId && claimed.meetingStartISO) {
      const sibling = await ScheduledDiscordMeetReminder.findOne({
        _id: { $ne: claimed._id },
        bookingId: claimed.bookingId,
        meetingStartISO: claimed.meetingStartISO,
        status: 'completed',
      }).lean();
      if (sibling) {
        await ScheduledDiscordMeetReminder.findOneAndUpdate(
          { _id: claimed._id },
          { $set: { status: 'cancelled', errorMessage: `sibling row ${sibling.reminderId} already sent (main backend dispatched)` } },
        );
        this._log.info({ reminderId, sibling: sibling.reminderId }, 'Discord reminder skipped — main backend already dispatched');
        return;
      }
    }

    const deliveryDriftMs = Date.now() - new Date(claimed.scheduledFor).getTime();

    try {
      // Resolve meeting start with 3-tier fallback so we can always compute "minutes until":
      // 1. claimed.meetingStartISO  2. booking.scheduledEventStartTime  3. scheduledFor + offset
      let booking = null;
      if (claimed.bookingId) {
        try {
          booking = await CampaignBooking.findOne({ bookingId: claimed.bookingId }).lean();
        } catch (_) { /* non-fatal */ }
      }

      const rawStart = claimed.meetingStartISO ? new Date(claimed.meetingStartISO) : null;
      const effectiveMeetingStart =
        (rawStart && !isNaN(rawStart.getTime()))
          ? rawStart
          : (booking?.scheduledEventStartTime)
            ? new Date(booking.scheduledEventStartTime)
            : (claimed.scheduledFor)
              ? new Date(new Date(claimed.scheduledFor).getTime() + DISCORD_MEET_REMINDER_OFFSET_MINUTES * 60 * 1000)
              : null;

      const minutesUntil = effectiveMeetingStart
        ? Math.max(0, Math.round((effectiveMeetingStart.getTime() - Date.now()) / 60000))
        : DISCORD_MEET_REMINDER_OFFSET_MINUTES;

      // Prefer pre-computed times stored at schedule time. Fall back to runtime
      // formatting only for legacy rows that don't have them.
      const clientTz = claimed.inviteeTimezone || booking?.inviteeTimezone || 'Asia/Kolkata';
      const meetingTime = isUsableTime(claimed.precomputedClientTime)
        ? claimed.precomputedClientTime
        : formatMeetingTime(effectiveMeetingStart, clientTz);
      const meetingTimeIndia = isUsableTime(claimed.precomputedIndiaTime)
        ? claimed.precomputedIndiaTime
        : formatMeetingTime(effectiveMeetingStart, 'Asia/Kolkata');

      const claimedBy = booking?.claimedBy?.name || booking?.claimedBy?.email || null;

      await this._discord.sendMeetReminder({
        clientName: claimed.clientName,
        meetingTime,
        meetingTimeIndia,
        meetingLink: claimed.meetingLink,
        minutesUntil,
        claimedBy,
      });

      await ScheduledDiscordMeetReminder.findOneAndUpdate(
        { reminderId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
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
