'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { normalizePhoneForReminders, isValidPhone } = require('../utils/phone');
const { minutesBefore, detectTimezoneFromPhone } = require('../utils/timezone');
const logger = require('../utils/logger');

async function webhookRoutes(fastify, opts) {
  const { callHandler, whatsAppHandler, discordReminderHandler, scheduler } = opts;

  // Calendly webhook — only processes call/WA/BDA/Discord reminder scheduling
  fastify.post('/calendly-webhook', async (req, reply) => {
    const body = req.body;
    if (!body || !body.event || !body.payload) {
      return reply.code(400).send({ error: 'Invalid payload' });
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
        return { status: 'scheduled', bookingId };

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
          return { status: 'rescheduled', bookingId };
        }

        return { status: 'cancelled', bookingId };
      }

      return { status: 'ignored', event };
    } catch (err) {
      logger.error({ err, bookingId, event }, 'Webhook processing failed');
      return reply.code(500).send({ error: 'Processing failed', message: err.message });
    }
  });

  // Twilio call status callback
  fastify.post('/call-status', async (req, reply) => {
    const { CallSid, CallStatus, To, From, AnsweredBy, CallDuration } = req.body || {};
    logger.info({ CallSid, CallStatus, To, AnsweredBy }, 'Call status update');

    if (CallSid) {
      const ScheduledCall = require('../models/ScheduledCall');
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

      const { discordService } = opts;
      if (discordService) {
        await discordService.sendCallStatus({
          phoneNumber: To,
          callSid: CallSid,
          status: CallStatus,
          answeredBy: AnsweredBy,
          duration: CallDuration,
        });
      }
    }

    // Twilio expects TwiML or 200
    reply.type('text/xml').send('<Response></Response>');
  });

  // Twilio IVR response
  fastify.post('/twilio-ivr', async (req, reply) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello! This is a reminder that your meeting is starting soon. Please join the meeting link sent to your email or WhatsApp. Press 1 to confirm, or press 2 to reschedule.</Say>
  <Gather numDigits="1" action="/twilio-ivr-response" method="POST">
    <Say voice="alice">Press 1 to confirm attendance, or press 2 to reschedule.</Say>
  </Gather>
  <Say voice="alice">We didn't receive any input. Goodbye!</Say>
</Response>`;
    reply.type('text/xml').send(twiml);
  });

  fastify.post('/twilio-ivr-response', async (req, reply) => {
    const digit = req.body?.Digits;
    let twiml;
    if (digit === '1') {
      twiml = '<Response><Say voice="alice">Great! We look forward to seeing you at the meeting. Goodbye!</Say></Response>';
    } else if (digit === '2') {
      twiml = '<Response><Say voice="alice">Please use the reschedule link sent to your email or WhatsApp to pick a new time. Goodbye!</Say></Response>';
    } else {
      twiml = '<Response><Say voice="alice">Invalid input. Goodbye!</Say></Response>';
    }
    reply.type('text/xml').send(twiml);
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
