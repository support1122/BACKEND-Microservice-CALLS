'use strict';

async function healthRoutes(fastify, opts) {
  const { scheduler, startTime } = opts;

  fastify.get('/health', async (req, reply) => {
    const stats = scheduler.getStats();
    return {
      status: 'ok',
      service: 'microservice-arc',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTimers: stats.activeTimers,
      byType: stats.byType,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/api/scheduler/stats', async (req, reply) => {
    return scheduler.getStats();
  });

  fastify.get('/api/scheduler/upcoming', async (req, reply) => {
    const ScheduledCall = require('../models/ScheduledCall');
    const ScheduledWhatsAppReminder = require('../models/ScheduledWhatsAppReminder');
    const ScheduledDiscordMeetReminder = require('../models/ScheduledDiscordMeetReminder');

    const [calls, whatsapp, discord] = await Promise.all([
      ScheduledCall.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
      ScheduledWhatsAppReminder.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
      ScheduledDiscordMeetReminder.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
    ]);

    return { calls, whatsapp, discord };
  });
}

module.exports = healthRoutes;
