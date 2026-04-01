'use strict';

function healthRoutes(app, opts) {
  const { scheduler, startTime } = opts;

  app.get('/health', (req, res) => {
    const stats = scheduler.getStats();
    res.json({
      status: 'ok',
      service: 'microservice-arc',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      activeTimers: stats.activeTimers,
      byType: stats.byType,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/scheduler/stats', (req, res) => {
    res.json(scheduler.getStats());
  });

  app.get('/api/scheduler/upcoming', async (req, res) => {
    try {
      const ScheduledCall = require('../models/ScheduledCall');
      const ScheduledWhatsAppReminder = require('../models/ScheduledWhatsAppReminder');
      const ScheduledDiscordMeetReminder = require('../models/ScheduledDiscordMeetReminder');

      const [calls, whatsapp, discord] = await Promise.all([
        ScheduledCall.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
        ScheduledWhatsAppReminder.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
        ScheduledDiscordMeetReminder.find({ status: 'pending' }).sort({ scheduledFor: 1 }).limit(10).lean(),
      ]);

      res.json({ calls, whatsapp, discord });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = healthRoutes;
