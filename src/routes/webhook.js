'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { normalizePhoneForReminders, isValidPhone } = require('../utils/phone');
const { minutesBefore, detectTimezoneFromPhone } = require('../utils/timezone');
const logger = require('../utils/logger');

function webhookRoutes(app, opts) {
  const { callHandler, whatsAppHandler, discordReminderHandler, scheduler, discordService } = opts;

  // Calendly webhook — only processes call/WA/BDA/Discord reminder scheduling
  app.post('/calendly-webhook', async (req, res) => {
    const body = req.body;
    if (!body || !body.event || !body.payload) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const { event, payload } = body;
    const invitee = payload.invitee || {};
    const scheduledEvent = payload.scheduled_event || payload.event || {};

    const clientName = invitee.name || 'Unknown';
    const clientEmail = invitee.email || '';
    const meetingStartISO = scheduledEvent.start_time;
    const meetingLink = scheduledEvent.location?.join_url || scheduledEvent.uri || '';
    const rescheduleLink = invitee.reschedule_url || '';
    const cancelLink = invitee.cancel_url || '';

    // Extract phone from questions/answers
    const phone = extractPhone(payload);
    const inviteeTimezone = invitee.timezone || detectTimezoneFromPhone(phone) || 'America/New_York';

    // Build a booking identifier
    const bookingId = buildBookingId(payload);

    logger.info({ event, bookingId, clientName, clientEmail, phone }, 'Calendly webhook received');

    try {
      if (event === 'invitee.created') {
        await handleMeetingBooked({
          bookingId, phone, clientName, clientEmail,
          meetingStartISO, meetingLink, rescheduleLink, inviteeTimezone,
        });
        return res.json({ status: 'scheduled', bookingId });

      } else if (event === 'invitee.rescheduled' || event === 'invitee.canceled') {
        // Cancel existing reminders first
        await scheduler.cancelAllForBooking(bookingId);
        logger.info({ bookingId, event }, 'Cancelled existing reminders');

        if (event === 'invitee.rescheduled') {
          const newPayload = payload.new_invitee || payload;
          const newEvent = newPayload.scheduled_event || scheduledEvent;
          const newStart = newEvent.start_time || meetingStartISO;
          const newLink = newEvent.location?.join_url || meetingLink;
          const newReschedule = newPayload.reschedule_url || rescheduleLink;

          await handleMeetingBooked({
            bookingId: bookingId + '_resched',
            phone, clientName, clientEmail,
            meetingStartISO: newStart,
            meetingLink: newLink,
            rescheduleLink: newReschedule,
            inviteeTimezone,
            source: 'reschedule',
          });
          return res.json({ status: 'rescheduled', bookingId });
        }

        return res.json({ status: 'cancelled', bookingId });
      }

      return res.json({ status: 'ignored', event });
    } catch (err) {
      logger.error({ err, bookingId, event }, 'Webhook processing failed');
      return res.status(500).json({ error: 'Processing failed', message: err.message });
    }
  });

  // Twilio call status callback
  app.post('/call-status', async (req, res) => {
    const { CallSid, CallStatus, To, From, AnsweredBy, CallDuration, Timestamp } = req.body || {};
    logger.info({ CallSid, CallStatus, To, From, AnsweredBy, CallDuration }, 'Call status update');

    if (CallSid) {
      const ScheduledCall = require('../models/ScheduledCall');

      // Update status history
      await ScheduledCall.findOneAndUpdate(
        { twilioCallSid: CallSid },
        {
          $push: {
            statusHistory: {
              status: CallStatus,
              answeredBy: AnsweredBy,
              timestamp: new Date(),
              duration: CallDuration ? parseInt(CallDuration) : undefined,
            },
          },
        }
      );

      // Lookup scheduled call for meeting info
      let meetingInfo = {};
      try {
        const scheduledCall = await ScheduledCall.findOne({ twilioCallSid: CallSid }).lean();
        if (scheduledCall) {
          // Fix meetingTime if "Invalid DateTime" — re-derive from ISO date
          let meetingTimeDisplay = scheduledCall.meetingTime || 'Unknown';
          if (meetingTimeDisplay === 'Invalid DateTime' && scheduledCall.meetingStartISO) {
            const { formatMeetingTime } = require('../utils/timezone');
            const tz = scheduledCall.inviteeTimezone || scheduledCall.metadata?.inviteeTimezone || 'America/New_York';
            meetingTimeDisplay = formatMeetingTime(scheduledCall.meetingStartISO, tz);
          }

          // Derive India time for team reference
          let meetingTimeIndia = '';
          if (scheduledCall.meetingStartISO) {
            const { formatMeetingTime } = require('../utils/timezone');
            meetingTimeIndia = formatMeetingTime(scheduledCall.meetingStartISO, 'Asia/Kolkata');
          }

          const combined = meetingTimeIndia
            ? `${meetingTimeDisplay} | India: ${meetingTimeIndia}`
            : meetingTimeDisplay;

          meetingInfo = {
            inviteeName: scheduledCall.inviteeName || 'Unknown',
            inviteeEmail: scheduledCall.inviteeEmail || 'Unknown',
            meetingTime: combined,
          };
        }
      } catch (lookupErr) {
        logger.warn({ err: lookupErr.message, CallSid }, 'Could not lookup scheduled call');
      }

      if (discordService) {
        await discordService.sendCallStatus({
          phoneNumber: To,
          fromNumber: From,
          callSid: CallSid,
          status: CallStatus,
          inviteeName: meetingInfo.inviteeName,
          inviteeEmail: meetingInfo.inviteeEmail,
          meetingTime: meetingInfo.meetingTime,
          answeredBy: AnsweredBy,
          duration: CallDuration ? parseInt(CallDuration) : undefined,
          timestamp: Timestamp || new Date().toISOString(),
        });
      }
    }

    // Twilio expects TwiML or 200
    res.type('text/xml').send('<Response></Response>');
  });

  // Twilio IVR response
  app.post('/twilio-ivr', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello! This is a reminder that your meeting is starting soon. Please join the meeting link sent to your email or WhatsApp. Press 1 to confirm, or press 2 to reschedule.</Say>
  <Gather numDigits="1" action="/twilio-ivr-response" method="POST">
    <Say voice="alice">Press 1 to confirm attendance, or press 2 to reschedule.</Say>
  </Gather>
  <Say voice="alice">We didn't receive any input. Goodbye!</Say>
</Response>`;
    res.type('text/xml').send(twiml);
  });

  app.post('/twilio-ivr-response', (req, res) => {
    const digit = req.body?.Digits;
    let twiml;
    if (digit === '1') {
      twiml = '<Response><Say voice="alice">Great! We look forward to seeing you at the meeting. Goodbye!</Say></Response>';
    } else if (digit === '2') {
      twiml = '<Response><Say voice="alice">Please use the reschedule link sent to your email or WhatsApp to pick a new time. Goodbye!</Say></Response>';
    } else {
      twiml = '<Response><Say voice="alice">Invalid input. Goodbye!</Say></Response>';
    }
    res.type('text/xml').send(twiml);
  });

  // --- Helpers ---

  async function handleMeetingBooked({ bookingId, phone, clientName, clientEmail, meetingStartISO, meetingLink, rescheduleLink, inviteeTimezone, source = 'calendly' }) {
    if (!meetingStartISO) {
      logger.warn({ bookingId }, 'No meeting start time, skipping reminder scheduling');
      return;
    }

    const meetingDate = new Date(meetingStartISO);
    const now = new Date();

    if (meetingDate <= now) {
      logger.warn({ bookingId, meetingStartISO }, 'Meeting time is in the past, skipping');
      return;
    }

    const normalizedPhone = phone ? normalizePhoneForReminders(phone) : null;
    const common = { clientName, clientEmail, meetingStartISO, meetingLink, rescheduleLink, inviteeTimezone, bookingId, source };

    const tasks = [];

    // 1. Schedule call (10 min before)
    if (normalizedPhone && isValidPhone(normalizedPhone)) {
      tasks.push(
        callHandler.schedule({ phoneNumber: normalizedPhone, ...common }).then(doc => {
          if (doc) scheduler.scheduleCall(doc);
        })
      );
    }

    // 2. Schedule WhatsApp reminders (5min, 2hour, 24hour)
    if (normalizedPhone && isValidPhone(normalizedPhone)) {
      for (const reminderType of ['5min', '2hour', '24hour']) {
        tasks.push(
          whatsAppHandler.schedule({ phoneNumber: normalizedPhone, ...common, reminderType, timezone: inviteeTimezone }).then(doc => {
            if (doc) scheduler.scheduleWhatsApp(doc);
          })
        );
      }
    }

    // 3. Schedule Discord meeting reminder
    tasks.push(
      discordReminderHandler.schedule(common).then(doc => {
        if (doc) scheduler.scheduleDiscordReminder(doc);
      })
    );

    await Promise.allSettled(tasks);
    logger.info({ bookingId, phone: normalizedPhone, reminderCount: tasks.length }, 'All reminders scheduled');
  }
}

function extractPhone(payload) {
  const questionsAndAnswers = payload.questions_and_answers || [];
  for (const qa of questionsAndAnswers) {
    const q = (qa.question || '').toLowerCase();
    if (q.includes('phone') || q.includes('mobile') || q.includes('whatsapp') || q.includes('contact')) {
      const answer = (qa.answer || '').trim();
      if (answer && /[\d+]/.test(answer)) return answer;
    }
  }

  const invitee = payload.invitee || {};
  if (invitee.text_reminder_number) return invitee.text_reminder_number;

  return null;
}

function buildBookingId(payload) {
  const uri = payload.uri || payload.invitee?.uri || '';
  if (uri) {
    const parts = uri.split('/');
    return parts[parts.length - 1] || `booking_${Date.now()}`;
  }
  const hash = crypto.createHash('md5')
    .update(`${payload.invitee?.email || ''}_${payload.scheduled_event?.start_time || ''}_${Date.now()}`)
    .digest('hex')
    .slice(0, 12);
  return `booking_${hash}`;
}

module.exports = webhookRoutes;
