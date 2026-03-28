'use strict';

const { normalizePhoneForReminders } = require('../utils/phone');
const logger = require('../utils/logger');

async function debugRoutes(fastify, opts) {
  const { callHandler, whatsAppHandler, discordReminderHandler, scheduler } = opts;

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
}

module.exports = debugRoutes;
