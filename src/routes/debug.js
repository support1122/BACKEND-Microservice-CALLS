'use strict';

const { normalizePhoneForReminders } = require('../utils/phone');
const { formatMeetingTime } = require('../utils/timezone');
const logger = require('../utils/logger');

async function debugRoutes(fastify, opts) {
  const { callHandler, whatsAppHandler, discordReminderHandler, scheduler, discordService } = opts;

  // Manual test call scheduling
  fastify.post('/api/debug/test-call', async (req, reply) => {
    const { phoneNumber, meetingStartISO, inviteeName, inviteeEmail, meetingLink, bookingId } = req.body || {};

    if (!phoneNumber || !meetingStartISO) {
      return reply.code(400).send({ error: 'phoneNumber and meetingStartISO required' });
    }

    const normalized = normalizePhoneForReminders(phoneNumber);
    const doc = await callHandler.schedule({
      phoneNumber: normalized,
      meetingStartISO,
      inviteeName: inviteeName || 'Test User',
      inviteeEmail: inviteeEmail || 'test@test.com',
      meetingLink: meetingLink || 'https://meet.example.com/test',
      rescheduleLink: '',
      inviteeTimezone: 'Asia/Kolkata',
      bookingId: bookingId || `debug_${Date.now()}`,
      source: 'debug',
    });

    if (doc) scheduler.scheduleCall(doc);
    logger.info({ callId: doc?.callId, phoneNumber: normalized }, 'Debug call scheduled');
    return { status: 'scheduled', call: doc };
  });

  // Manual test WhatsApp reminder
  fastify.post('/api/debug/test-whatsapp', async (req, reply) => {
    const { phoneNumber, meetingStartISO, clientName, reminderType } = req.body || {};

    if (!phoneNumber || !meetingStartISO) {
      return reply.code(400).send({ error: 'phoneNumber and meetingStartISO required' });
    }

    const normalized = normalizePhoneForReminders(phoneNumber);
    const doc = await whatsAppHandler.schedule({
      phoneNumber: normalized,
      meetingStartISO,
      clientName: clientName || 'Test User',
      clientEmail: 'test@test.com',
      meetingLink: 'https://meet.example.com/test',
      rescheduleLink: '',
      timezone: 'Asia/Kolkata',
      bookingId: `debug_wa_${Date.now()}`,
      reminderType: reminderType || '5min',
      source: 'debug',
    });

    if (doc) scheduler.scheduleWhatsApp(doc);
    return { status: 'scheduled', reminder: doc };
  });

  // Manual test Discord reminder
  fastify.post('/api/debug/test-discord', async (req, reply) => {
    const { meetingStartISO, clientName, clientEmail, meetingLink } = req.body || {};

    if (!meetingStartISO) {
      return reply.code(400).send({ error: 'meetingStartISO required' });
    }

    const doc = await discordReminderHandler.schedule({
      bookingId: `debug_discord_${Date.now()}`,
      clientName: clientName || 'Test User',
      clientEmail: clientEmail || 'test@test.com',
      meetingStartISO,
      meetingLink: meetingLink || 'https://meet.example.com/test',
      inviteeTimezone: 'Asia/Kolkata',
      source: 'debug',
    });

    if (doc) scheduler.scheduleDiscordReminder(doc);
    return { status: 'scheduled', reminder: doc };
  });

  // Cancel all reminders for a booking
  fastify.delete('/api/debug/cancel/:bookingId', async (req, reply) => {
    const { bookingId } = req.params;
    await scheduler.cancelAllForBooking(bookingId);
    return { status: 'cancelled', bookingId };
  });

  // ─────────────────────────────────────────────────────────────────
  //  POST /send/temp — Fire ALL notification types at once for
  //  testing: Discord (all channels) + WhatsApp (real message).
  //  No actual Twilio calls are made.
  //
  //  Body params (all optional, sensible defaults):
  //    clientName, clientEmail, phoneNumber, meetingStartISO,
  //    bdaEmail, inviteeTimezone, sendWhatsApp (bool)
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/send/temp', async (req, reply) => {
    const {
      clientName = 'Test Client',
      clientEmail = 'test@example.com',
      phoneNumber = '+919866855857',
      meetingStartISO,
      bdaEmail = 'sohith@flashfirehq.com',
      inviteeTimezone = 'Asia/Kolkata',
      sendWhatsApp = true,
    } = req.body || {};

    // Use provided time or 15 min from now
    const meetingStart = meetingStartISO
      ? new Date(meetingStartISO)
      : new Date(Date.now() + 15 * 60 * 1000);

    const meetingISO = meetingStart.toISOString();
    const formattedClient = formatMeetingTime(meetingStart, inviteeTimezone);
    const formattedIndia = formatMeetingTime(meetingStart, 'Asia/Kolkata');
    const meetingDateStr = meetingStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const bookingId = `test_${Date.now()}`;
    const callSid = `CA_TEST_${Date.now().toString(36)}`;
    const results = {};

    // 0. New Meeting Booked notification — same format as CalendlyWebhookController
    try {
      const bookingDetails = {
        'Booking ID': bookingId,
        'Campaign ID': 'test_campaign',
        'Invitee Name': clientName,
        'Invitee Email': clientEmail,
        'Invitee Phone': phoneNumber,
        'Google Meet Link': 'https://meet.google.com/test-link',
        'Real Google Meet Link': 'https://meet.google.com/test-link',
        'Reschedule Link': 'https://calendly.com/reschedulings/test',
        'Meeting Time (Client)': formattedClient,
        'Meeting Time (Team India)': formattedIndia,
        'Client Timezone': inviteeTimezone || 'Not provided',
        'Booked At': new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        'UTM Source': 'test',
        'UTM Medium': 'N/A',
        'UTM Campaign': 'N/A',
        'Database Status': '\u2705 SAVED (TEST)',
      };
      const msg = `\u{1F6A8} App Update: ${JSON.stringify(bookingDetails, null, 2)}`;
      results.meetingBooked = await discordService.send('hotLead', msg);
    } catch (err) {
      results.meetingBooked = { success: false, error: err.message };
    }

    // 1. Hot Lead / Meeting Reminder (with both client + India time)
    try {
      results.hotLead = await discordService.sendMeetReminder({
        clientName,
        meetingTime: formattedClient,
        meetingTimeIndia: formattedIndia,
        meetingLink: 'https://meet.google.com/test-link',
        minutesUntil: Math.max(0, Math.round((meetingStart.getTime() - Date.now()) / 60000)),
        claimedBy: bdaEmail,
      });
    } catch (err) {
      results.hotLead = { success: false, error: err.message };
    }

    // 2. Call Status — initiated (Discord only, NO real call)
    try {
      results.callInitiated = await discordService.sendCallStatus({
        phoneNumber,
        fromNumber: '+14722138424',
        callSid,
        status: 'initiated',
        inviteeName: clientName,
        inviteeEmail: clientEmail,
        meetingTime: `${formattedClient} | India: ${formattedIndia}`,
        answeredBy: 'Unknown',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      results.callInitiated = { success: false, error: err.message };
    }

    // 3. Call Status — ringing
    try {
      results.callRinging = await discordService.sendCallStatus({
        phoneNumber,
        fromNumber: '+14722138424',
        callSid,
        status: 'ringing',
        inviteeName: clientName,
        inviteeEmail: clientEmail,
        meetingTime: `${formattedClient} | India: ${formattedIndia}`,
        answeredBy: 'Unknown',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      results.callRinging = { success: false, error: err.message };
    }

    // 4. Call Status — completed
    try {
      results.callCompleted = await discordService.sendCallStatus({
        phoneNumber,
        fromNumber: '+14722138424',
        callSid,
        status: 'completed',
        inviteeName: clientName,
        inviteeEmail: clientEmail,
        meetingTime: `${formattedClient} | India: ${formattedIndia}`,
        answeredBy: 'human',
        duration: 15,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      results.callCompleted = { success: false, error: err.message };
    }

    // 5. BDA Absent
    try {
      results.bdaAbsent = await discordService.sendBdaAbsent({
        bookingId,
        bdaEmail,
        clientName,
        meetingStart: formattedClient,
      });
    } catch (err) {
      results.bdaAbsent = { success: false, error: err.message };
    }

    // 6. BDA Present
    try {
      results.bdaPresent = await discordService.sendBdaPresent({
        bookingId,
        bdaEmail,
        clientName,
        meetingStart: formattedClient,
      });
    } catch (err) {
      results.bdaPresent = { success: false, error: err.message };
    }

    // 7. BDA Duration — time spent in meeting
    try {
      const joinTime = new Date(meetingStart.getTime() - 2 * 60 * 1000); // joined 2 min early
      const leftTime = new Date(meetingStart.getTime() + 18 * 60 * 1000); // left after 18 min
      results.bdaDuration = await discordService.sendBdaDuration({
        bookingId,
        bdaEmail,
        clientName,
        meetingStart: formattedClient,
        durationMinutes: 20,
        joinedAt: formatMeetingTime(joinTime, 'Asia/Kolkata'),
        leftAt: formatMeetingTime(leftTime, 'Asia/Kolkata'),
      });
    } catch (err) {
      results.bdaDuration = { success: false, error: err.message };
    }

    // 8. WhatsApp test message — sends a REAL WhatsApp to the phone number
    if (sendWhatsApp && whatsAppHandler) {
      try {
        const waDoc = await whatsAppHandler.schedule({
          phoneNumber: normalizePhoneForReminders(phoneNumber),
          meetingStartISO: meetingISO,
          clientName,
          clientEmail,
          meetingLink: 'https://meet.google.com/test-link',
          rescheduleLink: 'https://calendly.com/reschedulings/test',
          timezone: inviteeTimezone,
          bookingId: `test_wa_${Date.now()}`,
          reminderType: '5min',
          source: 'debug',
        });

        if (waDoc) {
          // Execute immediately so the user sees the WhatsApp message right away
          await whatsAppHandler.execute(waDoc);
          results.whatsApp = { success: true, reminderId: waDoc.reminderId, phone: phoneNumber };
        } else {
          results.whatsApp = { success: false, error: 'WhatsApp schedule returned null' };
        }
      } catch (err) {
        results.whatsApp = { success: false, error: err.message };
      }
    } else {
      results.whatsApp = { success: false, skipped: true, reason: sendWhatsApp ? 'whatsAppHandler not available' : 'sendWhatsApp=false' };
    }

    // Summary
    const totalSent = Object.values(results).filter((r) => r.success).length;
    const totalFailed = Object.values(results).filter((r) => !r.success).length;

    logger.info({ totalSent, totalFailed, results }, '/send/temp completed');

    return {
      status: totalFailed === 0 ? 'all_sent' : totalSent === 0 ? 'all_failed' : 'partial',
      totalSent,
      totalFailed,
      meetingTime: {
        client: formattedClient,
        india: formattedIndia,
        timezone: inviteeTimezone,
        iso: meetingISO,
      },
      results,
      webhooks: {
        hotLead: !!discordService.webhooks.hotLead,
        call: !!discordService.webhooks.call,
        bdaAttendance: !!discordService.webhooks.bdaAttendance,
        bdaAbsent: !!discordService.webhooks.bdaAbsent,
        bdaDuration: !!discordService.webhooks.bdaDuration,
        meet2min: !!discordService.webhooks.meet2min,
      },
    };
  });
}

module.exports = debugRoutes;
