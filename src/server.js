'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const env = require('./config/env');
const { connect, disconnect } = require('./db/connection');
const logger = require('./utils/logger');

// Services
const TwilioService = require('./services/TwilioService');
const WatiService = require('./services/WatiService');
const DiscordService = require('./services/DiscordService');

// Handlers
const CallHandler = require('./handlers/CallHandler');
const WhatsAppHandler = require('./handlers/WhatsAppHandler');
const DiscordReminderHandler = require('./handlers/DiscordReminderHandler');

// Scheduler
const UnifiedScheduler = require('./scheduler/UnifiedScheduler');

// Routes
const healthRoutes = require('./routes/health');
const webhookRoutes = require('./routes/webhook');
const debugRoutes = require('./routes/debug');

const startTime = Date.now();

function buildApp() {
  const app = express();

  // Middleware
  app.set('trust proxy', true);
  app.use(cors({ origin: true, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Initialize services
  const twilioService = new TwilioService({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
  });

  const watiService = new WatiService({
    baseUrl: env.WATI_API_BASE_URL,
    token: env.WATI_API_TOKEN,
    tenantId: env.WATI_TENANT_ID,
    channelNumber: env.WATI_CHANNEL_NUMBER,
  });

  const discordService = new DiscordService({
    hotLead: env.DISCORD_HOT_LEAD_WEBHOOK_URL,
    call: env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
    meet2min: env.DISCORD_MEET_2MIN_WEBHOOK_URL,
    bdaAttendance: env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL,
    bdaAbsent: env.DISCORD_BDA_ABSENT_WEBHOOK_URL,
    bdaDuration: env.DISCORD_BDA_DURATION_WEBHOOK_URL,
  });

  // Initialize handlers
  const callHandler = new CallHandler({ twilioService, discordService, logger });
  const whatsAppHandler = new WhatsAppHandler({ watiService, discordService, logger });
  const discordReminderHandler = new DiscordReminderHandler({ discordService, logger });

  // Initialize scheduler
  const scheduler = new UnifiedScheduler({
    callHandler,
    whatsAppHandler,
    discordReminderHandler,
    bdaHandler: null,
    logger,
  });

  // Store references on app for shutdown access
  app.scheduler = scheduler;

  // Route options shared across all route files
  const routeOpts = { scheduler, callHandler, whatsAppHandler, discordReminderHandler, discordService, startTime };

  // Register routes
  healthRoutes(app, routeOpts);
  webhookRoutes(app, routeOpts);
  debugRoutes(app, routeOpts);

  // Root
  app.get('/', (req, res) => {
    res.json({
      service: 'microservice-arc',
      version: '1.0.0',
      status: 'running',
      purpose: 'Precision reminders: Calls, WhatsApp, Discord (BDA attendance on main backend)',
    });
  });

  return app;
}

async function start() {
  try {
    // 1. Connect to MongoDB
    await connect();
    logger.info('MongoDB connected');

    // 2. Build Express app
    const app = buildApp();

    // 3. Start scheduler (preloads timers from DB)
    await app.scheduler.start();
    logger.info('UnifiedScheduler started — timers preloaded');

    // 4. Listen
    const port = env.PORT;
    const server = app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, `Microservice-ARC running on port ${port}`);
    });

    // ── Self-ping keep-alive (prevents Render free-tier cold sleep) ──
    const SELF_PING_INTERVAL_MS = 4 * 60 * 1000; // every 4 minutes
    const selfPingUrl = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/health`
      : `http://localhost:${port}/health`;

    const selfPingTimer = setInterval(async () => {
      try {
        const res = await fetch(selfPingUrl, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          logger.debug({ url: selfPingUrl }, 'Self-ping OK');
        } else {
          logger.warn({ status: res.status }, 'Self-ping non-OK response');
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Self-ping failed (will retry next cycle)');
      }
    }, SELF_PING_INTERVAL_MS);

    logger.info({ intervalMs: SELF_PING_INTERVAL_MS, url: selfPingUrl }, 'Self-ping keep-alive started');

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down...');
      clearInterval(selfPingTimer);
      await app.scheduler.stop();
      server.close();
      await disconnect();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return app;
  } catch (err) {
    logger.fatal({ err }, 'Failed to start microservice');
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  start();
}

module.exports = { buildApp, start };
