'use strict';

const CampaignBooking = require('../models/CampaignBooking');
const BdaAttendance = require('../models/BdaAttendance');
const ReminderError = require('../models/ReminderError');

class BdaHandler {
  /**
   * @param {Object} deps
   * @param {Object} deps.discordService
   * @param {Object} deps.logger
   */
  constructor({ discordService, logger }) {
    this._discord = discordService;
    this._log = logger.child({ component: 'BdaHandler' });
    this._pollTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Polling lifecycle                                                 */
  /* ------------------------------------------------------------------ */

  startPolling(intervalMs = 60000) {
    if (this._pollTimer) {
      this._log.warn('BDA polling already running');
      return;
    }

    this._log.info({ intervalMs }, 'Starting BDA absence polling');

    // Run immediately, then on interval
    this.pollForAbsentBDAs().catch((err) =>
      this._log.error({ err }, 'Initial BDA poll failed'),
    );

    this._pollTimer = setInterval(() => {
      this.pollForAbsentBDAs().catch((err) =>
        this._log.error({ err }, 'BDA poll cycle failed'),
      );
    }, intervalMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      this._log.info('BDA absence polling stopped');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Core poll logic                                                   */
  /* ------------------------------------------------------------------ */

  async pollForAbsentBDAs() {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const sixtySecondsAgo = new Date(now.getTime() - 60 * 1000);

    // Find bookings where the meeting should have started (between 2h ago and 60s ago),
    // status is still 'scheduled', and a BDA is assigned
    const bookings = await CampaignBooking.find({
      scheduledEventStartTime: { $gte: twoHoursAgo, $lte: sixtySecondsAgo },
      bookingStatus: 'scheduled',
      claimedBy: { $exists: true, $ne: null },
    }).lean();

    if (bookings.length === 0) return;

    this._log.debug({ count: bookings.length }, 'Checking bookings for absent BDAs');

    for (const booking of bookings) {
      try {
        await this._checkAndNotify(booking);
      } catch (err) {
        this._log.error(
          { err, bookingId: booking.bookingId },
          'Error checking BDA attendance',
        );

        await ReminderError.create({
          bookingId: booking.bookingId,
          category: 'bda',
          severity: 'warning',
          message: `BDA absence check failed: ${err.message}`,
          stack: err.stack,
          source: 'BdaHandler.pollForAbsentBDAs',
        }).catch(() => {});
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Safely extract BDA email from claimedBy field.
   * claimedBy can be a plain string OR an object like { email, name, claimedAt }.
   */
  _extractBdaEmail(claimedBy) {
    if (!claimedBy) return null;
    if (typeof claimedBy === 'string') return claimedBy;
    if (typeof claimedBy === 'object') {
      // Handle { email: '...', name: '...', claimedAt: '...' } shape
      const email = claimedBy.email || claimedBy.bdaEmail || null;
      if (typeof email === 'string' && email.length > 0) return email;
      // If email is null/empty, try name as fallback identifier
      const name = claimedBy.name || claimedBy.bdaName || null;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    return null;
  }

  async _checkAndNotify(booking) {
    const { bookingId } = booking;
    const bdaEmail = this._extractBdaEmail(booking.claimedBy);

    if (!bdaEmail) {
      this._log.warn({ bookingId, claimedBy: booking.claimedBy }, 'Cannot extract BDA email from claimedBy — skipping');
      return;
    }

    // Check if an attendance record already exists
    const existing = await BdaAttendance.findOne({ bookingId }).lean();

    // If attendance exists and already notified, skip
    if (existing && existing.discordNotified) {
      return;
    }

    // If attendance exists with status 'present', BDA showed up — skip
    if (existing && existing.status === 'present') {
      return;
    }

    // No attendance record or record is 'absent'/'partial' but not yet notified
    if (!existing) {
      // Create an absent record
      await BdaAttendance.create({
        attendanceId: `att_${bookingId}_${Date.now()}`,
        bookingId,
        bdaEmail,
        status: 'absent',
        meetingScheduledStart: booking.scheduledEventStartTime,
        meetingScheduledEnd: booking.scheduledEventEndTime,
        discordNotified: false,
      });
    }

    // Format meeting start safely
    let meetingStartStr = 'Unknown';
    if (booking.scheduledEventStartTime) {
      try {
        meetingStartStr = booking.scheduledEventStartTime instanceof Date
          ? booking.scheduledEventStartTime.toISOString()
          : String(booking.scheduledEventStartTime);
      } catch { /* keep 'Unknown' */ }
    }

    // Send Discord notification
    await this._discord.sendBdaAbsent({
      bookingId,
      bdaEmail,
      clientName: booking.clientName || 'Unknown',
      meetingStart: meetingStartStr,
    });

    // Mark as notified
    await BdaAttendance.findOneAndUpdate(
      { bookingId },
      { $set: { discordNotified: true } },
    );

    this._log.info({ bookingId, bdaEmail }, 'BDA absent notification sent');
  }
}

module.exports = BdaHandler;
