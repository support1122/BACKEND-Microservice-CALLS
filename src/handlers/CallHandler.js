'use strict';

const ScheduledCall = require('../models/ScheduledCall');
const ReminderError = require('../models/ReminderError');
const { minutesBefore } = require('../utils/timezone');
const { REMINDER_DRIFT_WARN_MS } = require('../config/env');

class CallHandler {
  /**
   * @param {Object} deps
   * @param {Object} deps.twilioService
   * @param {Object} deps.discordService
   * @param {Object} deps.logger
   */
  constructor({ twilioService, discordService, logger }) {
    this._twilio = twilioService;
    this._discord = discordService;
    this._log = logger.child({ component: 'CallHandler' });
  }

  /* ------------------------------------------------------------------ */
  /*  Schedule                                                          */
  /* ------------------------------------------------------------------ */

  async schedule({
    phoneNumber,
    meetingStartISO,
    inviteeName,
    inviteeEmail,
    meetingLink,
    rescheduleLink,
    inviteeTimezone,
    bookingId,
    source = 'calendly',
  }) {
    const scheduledFor = minutesBefore(meetingStartISO, 10);
    const callId = `call_${bookingId}_${Date.now()}`;

    const doc = await ScheduledCall.create({
      callId,
      phoneNumber,
      scheduledFor,
      meetingStartISO,
      inviteeName,
      inviteeEmail,
      meetingLink,
      rescheduleLink,
      inviteeTimezone,
      bookingId,
      status: 'pending',
      source,
    });

    this._log.info({ callId, bookingId, scheduledFor }, 'Call scheduled');
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /*  Execute                                                           */
  /* ------------------------------------------------------------------ */

  async execute(callDoc) {
    const { callId, bookingId } = callDoc;
    this._log.info({ callId }, 'Executing call');

    // Atomic claim
    const claimed = await ScheduledCall.findOneAndUpdate(
      { callId, status: 'pending' },
      { $set: { status: 'processing', processedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true },
    );

    if (!claimed) {
      this._log.warn({ callId }, 'Call already processed or cancelled, skipping');
      return;
    }

    // Fallback dedupe: skip if main backend already placed call for this booking+meeting.
    if (claimed.bookingId && claimed.meetingStartISO) {
      const sibling = await ScheduledCall.findOne({
        _id: { $ne: claimed._id },
        bookingId: claimed.bookingId,
        meetingStartISO: claimed.meetingStartISO,
        status: 'completed',
      }).lean();
      if (sibling) {
        await ScheduledCall.findOneAndUpdate(
          { _id: claimed._id },
          { $set: { status: 'cancelled', errorMessage: `sibling row ${sibling.callId} already placed (main backend dispatched)` } },
        );
        this._log.info({ callId, sibling: sibling.callId }, 'Call skipped — main backend already dispatched');
        return;
      }
    }

    const deliveryDriftMs = Date.now() - new Date(claimed.scheduledFor).getTime();

    try {
      const result = await this._twilio.makeCall({
        to: claimed.phoneNumber,
        meetingTime: claimed.meetingStartISO,
        meetingLink: claimed.meetingLink,
        inviteeName: claimed.inviteeName,
        statusCallbackUrl: `${process.env.MICROSERVICE_BASE_URL || 'https://api.flashfirejobs.com:4000'}/call-status`,
        ivrUrl: `${process.env.MICROSERVICE_BASE_URL || 'https://api.flashfirejobs.com:4000'}/twilio-ivr`,
      });

      if (!result.success) {
        throw new Error(result.error || 'Twilio call failed');
      }

      await ScheduledCall.findOneAndUpdate(
        { callId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            twilioCallSid: result.callSid || null,
            deliveryDriftMs,
          },
        },
      );

      if (deliveryDriftMs > REMINDER_DRIFT_WARN_MS) {
        this._log.warn({ callId, deliveryDriftMs }, 'Call delivery drift exceeds threshold');
      }

      this._log.info({ callId, deliveryDriftMs }, 'Call completed');

      // Discord notification
      await this._notifyDiscord(claimed, 'completed', deliveryDriftMs).catch((err) =>
        this._log.error({ err, callId }, 'Discord call-status notification failed'),
      );
    } catch (err) {
      this._log.error({ err, callId }, 'Call execution failed');

      if (claimed.attempts < claimed.maxAttempts) {
        await ScheduledCall.findOneAndUpdate(
          { callId },
          { $set: { status: 'pending', errorMessage: err.message } },
        );
        this._log.info({ callId, attempt: claimed.attempts }, 'Call queued for retry');
      } else {
        await ScheduledCall.findOneAndUpdate(
          { callId },
          { $set: { status: 'failed', errorMessage: err.message, deliveryDriftMs } },
        );

        await ReminderError.create({
          bookingId,
          clientPhone: claimed.phoneNumber,
          clientEmail: claimed.inviteeEmail,
          category: 'call',
          severity: 'error',
          message: `Call failed after ${claimed.maxAttempts} attempts: ${err.message}`,
          details: { callId, attempts: claimed.attempts },
          stack: err.stack,
          source: 'CallHandler.execute',
        });

        this._log.error({ callId }, 'Call permanently failed');
      }

      await this._notifyDiscord(claimed, 'failed', deliveryDriftMs).catch((e) =>
        this._log.error({ err: e, callId }, 'Discord call-failure notification failed'),
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Cancel                                                            */
  /* ------------------------------------------------------------------ */

  async cancel(callId) {
    await ScheduledCall.findOneAndUpdate(
      { callId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ callId }, 'Call cancelled');
  }

  async cancelForBooking(bookingId) {
    const result = await ScheduledCall.updateMany(
      { bookingId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );
    this._log.info({ bookingId, cancelled: result.modifiedCount }, 'Calls cancelled for booking');
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  async _notifyDiscord(callDoc, status, driftMs) {
    await this._discord.sendCallStatus({
      phoneNumber: callDoc.phoneNumber,
      callSid: callDoc.twilioCallSid || callDoc.callId,
      status,
      inviteeName: callDoc.inviteeName,
    });
  }
}

module.exports = CallHandler;
