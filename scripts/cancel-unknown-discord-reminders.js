'use strict';

/**
 * cancel-unknown-discord-reminders.js  (Microservice side)
 *
 * Twin of the script in flashfire-website-backend/scripts/.  This one
 * uses the Microservice's own model definitions and connection helper so
 * it can be run from the Microservice repo without pulling in main-backend
 * code.
 *
 * What it does:
 *   For every PENDING / PROCESSING ScheduledDiscordMeetReminder it walks
 *   the row and decides:
 *     1. precomputedClientTime + precomputedIndiaTime are both usable
 *        AND meetingStartISO parses → leave it alone (already fine)
 *     2. otherwise REPAIR in place by recomputing both precomputed fields
 *        from booking.scheduledEventStartTime + inviteeTimezone
 *     3. if no usable meetingStart can be recovered → CANCEL the row so
 *        it never fires "Time (Client): Unknown" to Discord
 *
 * Crash safety:
 *   The same atomic { status: 'pending' } -> 'processing' findOneAndUpdate
 *   used by both the main backend's poller and the Microservice's poller
 *   guarantees only one server actually sends a given row.  This script
 *   only mutates rows that are still 'pending' or 'processing', never
 *   'completed' / 'failed' / 'cancelled', so it can be run any time.
 *
 * Usage:
 *   node scripts/cancel-unknown-discord-reminders.js           # apply
 *   node scripts/cancel-unknown-discord-reminders.js --dry-run # log only
 *
 * Env: MONGODB_URI (read from .env via src/config/env)
 */

const { DateTime, IANAZone } = require('luxon');
const { connect, disconnect } = require('../src/db/connection');
const ScheduledDiscordMeetReminder = require('../src/models/ScheduledDiscordMeetReminder');
const CampaignBooking = require('../src/models/CampaignBooking');
const { DISCORD_MEET_REMINDER_OFFSET_MINUTES } = require('../src/config/env');

const DRY_RUN = process.argv.includes('--dry-run');
const OFFSET_MIN = DISCORD_MEET_REMINDER_OFFSET_MINUTES || 5;

function isUsableTime(v) {
  return (
    v != null &&
    v !== '' &&
    v !== 'Unknown' &&
    !String(v).startsWith('Unknown') &&
    v !== 'undefined'
  );
}

function formatMeetingWallTime(meetingStart, inviteeTimezone) {
  if (!meetingStart) return null;
  const instant =
    meetingStart instanceof Date
      ? DateTime.fromJSDate(meetingStart, { zone: 'utc' })
      : DateTime.fromISO(String(meetingStart), { zone: 'utc' });
  if (!instant.isValid) return null;
  const zone =
    inviteeTimezone &&
    typeof inviteeTimezone === 'string' &&
    IANAZone.isValidZone(inviteeTimezone.trim())
      ? inviteeTimezone.trim()
      : 'Asia/Kolkata';
  return instant.setZone(zone).toFormat('ff');
}

async function main() {
  console.log(
    `\n🛡️  [Microservice] cancel-unknown-discord-reminders ${
      DRY_RUN ? '[DRY RUN]' : ''
    }\n`,
  );

  await connect();
  console.log('✅ MongoDB connected\n');

  // Look at every pending/processing Discord reminder whose scheduledFor is in
  // the future OR within the last 30 min (covers reminders that just slipped).
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const pending = await ScheduledDiscordMeetReminder.find({
    status: { $in: ['pending', 'processing'] },
    scheduledFor: { $gte: cutoff },
  }).lean();

  console.log(`📋 Pending/processing reminders to inspect: ${pending.length}\n`);

  const stats = { repaired: 0, cancelled: 0, alreadyFine: 0, errors: 0 };

  for (const r of pending) {
    try {
      const hasGoodPrecomputed =
        isUsableTime(r.precomputedClientTime) &&
        isUsableTime(r.precomputedIndiaTime);
      const meetingStart = r.meetingStartISO ? new Date(r.meetingStartISO) : null;
      const meetingStartValid =
        meetingStart && !Number.isNaN(meetingStart.getTime());

      if (hasGoodPrecomputed && meetingStartValid) {
        stats.alreadyFine++;
        continue;
      }

      // Try to repair from booking
      let booking = null;
      if (r.bookingId) {
        booking = await CampaignBooking.findOne({ bookingId: r.bookingId }).lean();
      }
      if (!booking && r.clientEmail) {
        booking = await CampaignBooking.findOne({
          clientEmail: r.clientEmail.toLowerCase().trim(),
        })
          .sort({ createdAt: -1 })
          .limit(1)
          .lean();
      }

      const bookingStart = booking?.scheduledEventStartTime
        ? new Date(booking.scheduledEventStartTime)
        : null;
      const bookingStartValid =
        bookingStart && !Number.isNaN(bookingStart.getTime());

      // Final fallback: derive from scheduledFor + offset
      const derivedFromScheduledFor = r.scheduledFor
        ? new Date(new Date(r.scheduledFor).getTime() + OFFSET_MIN * 60 * 1000)
        : null;

      const effectiveStart = bookingStartValid
        ? bookingStart
        : meetingStartValid
          ? meetingStart
          : derivedFromScheduledFor;

      if (!effectiveStart || Number.isNaN(effectiveStart.getTime())) {
        if (!DRY_RUN) {
          await ScheduledDiscordMeetReminder.updateOne(
            { _id: r._id },
            {
              $set: {
                status: 'cancelled',
                errorMessage:
                  'Cancelled by cancel-unknown-discord-reminders.js: no usable meetingStart',
              },
            },
          );
        }
        stats.cancelled++;
        console.log(
          `🚫 CANCELLED ${r.clientName || r.clientEmail || r.reminderId} (no recoverable start)`,
        );
        continue;
      }

      const inviteeTz =
        r.inviteeTimezone || booking?.inviteeTimezone || 'Asia/Kolkata';
      const newClient = formatMeetingWallTime(effectiveStart, inviteeTz);
      const newIndia = formatMeetingWallTime(effectiveStart, 'Asia/Kolkata');

      if (!isUsableTime(newClient) || !isUsableTime(newIndia)) {
        if (!DRY_RUN) {
          await ScheduledDiscordMeetReminder.updateOne(
            { _id: r._id },
            {
              $set: {
                status: 'cancelled',
                errorMessage:
                  'Cancelled by cancel-unknown-discord-reminders.js: format failed',
              },
            },
          );
        }
        stats.cancelled++;
        console.log(
          `🚫 CANCELLED ${r.clientName || r.clientEmail || r.reminderId} (format failed)`,
        );
        continue;
      }

      // Mongoose model declares meetingStartISO as String — store ISO string
      // so the schema cast doesn't reject the Date object on save.
      if (!DRY_RUN) {
        await ScheduledDiscordMeetReminder.updateOne(
          { _id: r._id },
          {
            $set: {
              meetingStartISO: effectiveStart.toISOString(),
              inviteeTimezone: inviteeTz,
              precomputedClientTime: newClient,
              precomputedIndiaTime: newIndia,
              errorMessage: null,
            },
          },
        );
      }
      stats.repaired++;
      console.log(
        `✅ REPAIRED ${r.clientName || r.clientEmail || r.reminderId}: client="${newClient}" india="${newIndia}"`,
      );
    } catch (err) {
      stats.errors++;
      console.error(`  ERROR processing ${r.reminderId}: ${err.message}`);
    }
  }

  console.log('\n── Summary ──');
  console.log(JSON.stringify(stats, null, 2));
  await disconnect();
  console.log('\n✅ Done\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
