'use strict';

/**
 * BACKFILL SCRIPT — Schedule reminders for all existing booked meetings in DB
 *
 * This script reads all CampaignBookings with status 'scheduled' and future meeting times,
 * then creates ScheduledCall, ScheduledWhatsAppReminder, and ScheduledDiscordMeetReminder
 * records for any that don't already have them.
 *
 * Usage: node scripts/backfill-reminders.js [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be scheduled without actually creating records
 */

const env = require('../src/config/env');
const { connect, disconnect } = require('../src/db/connection');
const ScheduledCall = require('../src/models/ScheduledCall');
const ScheduledWhatsAppReminder = require('../src/models/ScheduledWhatsAppReminder');
const ScheduledDiscordMeetReminder = require('../src/models/ScheduledDiscordMeetReminder');
const CampaignBooking = require('../src/models/CampaignBooking');
const { normalizePhoneForReminders, isValidPhone } = require('../src/utils/phone');
const { minutesBefore } = require('../src/utils/timezone');

const DRY_RUN = process.argv.includes('--dry-run');
const DISCORD_OFFSET_MINUTES = env.DISCORD_MEET_REMINDER_OFFSET_MINUTES || 5;

const stats = {
  totalBookings: 0,
  alreadyHasReminders: 0,
  scheduled: { calls: 0, whatsapp: 0, discord: 0 },
  skipped: { noPhone: 0, pastMeeting: 0, invalidPhone: 0 },
  errors: 0,
};

async function main() {
  console.log('\n========================================');
  console.log('  BACKFILL REMINDERS FOR EXISTING BOOKINGS');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log('========================================\n');

  await connect();
  console.log('MongoDB connected\n');

  const now = new Date();

  // Find all scheduled bookings with future meeting times
  const bookings = await CampaignBooking.find({
    bookingStatus: { $in: ['scheduled', 'not-scheduled'] },
    scheduledEventStartTime: { $gt: now },
  })
    .sort({ scheduledEventStartTime: 1 })
    .lean();

  stats.totalBookings = bookings.length;
  console.log(`Found ${bookings.length} future bookings to process\n`);

  for (const booking of bookings) {
    try {
      await processBooking(booking, now);
    } catch (err) {
      stats.errors++;
      console.error(`  ERROR processing ${booking.bookingId}: ${err.message}`);
    }
  }

  // Print summary
  console.log('\n========================================');
  console.log('  BACKFILL SUMMARY');
  console.log('========================================');
  console.log(`  Total bookings found:    ${stats.totalBookings}`);
  console.log(`  Already had reminders:   ${stats.alreadyHasReminders}`);
  console.log(`  Calls scheduled:         ${stats.scheduled.calls}`);
  console.log(`  WhatsApp scheduled:      ${stats.scheduled.whatsapp}`);
  console.log(`  Discord scheduled:       ${stats.scheduled.discord}`);
  console.log(`  Skipped (no phone):      ${stats.skipped.noPhone}`);
  console.log(`  Skipped (past meeting):  ${stats.skipped.pastMeeting}`);
  console.log(`  Skipped (invalid phone): ${stats.skipped.invalidPhone}`);
  console.log(`  Errors:                  ${stats.errors}`);
  console.log('========================================\n');

  await disconnect();
  process.exit(0);
}

async function processBooking(booking, now) {
  const {
    bookingId,
    clientName,
    clientEmail,
    clientPhone,
    scheduledEventStartTime,
    calendlyMeetLink,
    inviteeTimezone,
  } = booking;

  const meetingStart = new Date(scheduledEventStartTime);
  const meetingStartISO = meetingStart.toISOString();

  // Check if meeting is still in the future
  if (meetingStart <= now) {
    stats.skipped.pastMeeting++;
    return;
  }

  // Check if reminders already exist for this booking
  const existingCall = await ScheduledCall.findOne({ bookingId, status: { $in: ['pending', 'processing'] } }).lean();
  const existingWA = await ScheduledWhatsAppReminder.findOne({ bookingId, status: { $in: ['pending', 'processing'] } }).lean();
  const existingDiscord = await ScheduledDiscordMeetReminder.findOne({ bookingId, status: { $in: ['pending', 'processing'] } }).lean();

  if (existingCall && existingWA && existingDiscord) {
    stats.alreadyHasReminders++;
    return;
  }

  const normalizedPhone = clientPhone ? normalizePhoneForReminders(clientPhone) : null;
  const hasValidPhone = normalizedPhone && isValidPhone(normalizedPhone);
  const meetingLink = calendlyMeetLink || '';
  const tz = inviteeTimezone || 'America/New_York';

  console.log(`  ${bookingId}: ${clientName || 'Unknown'} | ${normalizedPhone || 'no phone'} | ${meetingStartISO}`);

  // 1. Schedule Call (10 min before)
  if (!existingCall && hasValidPhone) {
    const callTime = minutesBefore(meetingStartISO, 10);
    if (callTime > now) {
      if (!DRY_RUN) {
        await ScheduledCall.create({
          callId: `call_backfill_${bookingId}_${Date.now()}`,
          phoneNumber: normalizedPhone,
          scheduledFor: callTime,
          meetingStartISO,
          inviteeName: clientName || 'Valued Client',
          inviteeEmail: clientEmail,
          meetingLink,
          inviteeTimezone: tz,
          bookingId,
          status: 'pending',
          source: 'manual',
        });
      }
      stats.scheduled.calls++;
      console.log(`    + Call scheduled for ${callTime.toISOString()}`);
    }
  } else if (!hasValidPhone && !existingCall) {
    stats.skipped.noPhone++;
  }

  // 2. Schedule WhatsApp reminders (5min, 2h, 24h before)
  if (!existingWA && hasValidPhone) {
    const waOffsets = [
      { type: '5min', minutes: 5 },
      { type: '2hour', minutes: 120 },
      { type: '24hour', minutes: 1440 },
    ];

    for (const { type, minutes } of waOffsets) {
      const waTime = minutesBefore(meetingStartISO, minutes);
      if (waTime > now) {
        if (!DRY_RUN) {
          await ScheduledWhatsAppReminder.create({
            reminderId: `wa_backfill_${bookingId}_${type}_${Date.now()}`,
            phoneNumber: normalizedPhone,
            scheduledFor: waTime,
            meetingStartISO,
            clientName: clientName || 'Valued Client',
            clientEmail: clientEmail,
            meetingLink,
            rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/feedback-flashfire/30min',
            timezone: tz,
            bookingId,
            reminderType: type,
            status: 'pending',
            source: 'manual',
          });
        }
        stats.scheduled.whatsapp++;
        console.log(`    + WA ${type} scheduled for ${waTime.toISOString()}`);
      }
    }
  }

  // 3. Schedule Discord meeting reminder (5 min before)
  if (!existingDiscord) {
    const discordTime = minutesBefore(meetingStartISO, DISCORD_OFFSET_MINUTES);
    if (discordTime > now) {
      if (!DRY_RUN) {
        await ScheduledDiscordMeetReminder.create({
          reminderId: `discord_backfill_${bookingId}_${Date.now()}`,
          bookingId,
          clientName: clientName || 'Valued Client',
          clientEmail: clientEmail,
          meetingStartISO,
          scheduledFor: discordTime,
          meetingLink,
          inviteeTimezone: tz,
          status: 'pending',
          source: 'manual',
        });
      }
      stats.scheduled.discord++;
      console.log(`    + Discord reminder scheduled for ${discordTime.toISOString()}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
