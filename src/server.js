'use strict';

const Fastify = require('fastify');
const cors = require('@fastify/cors');
const compress = require('@fastify/compress');
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

async function buildApp() {
  const app = Fastify({
    logger: false, // we use our own pino logger
    trustProxy: true,
    bodyLimit: 1048576, // 1MB
    caseSensitive: false,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(compress);

  // Parse URL-encoded bodies (Twilio sends form data)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
      const parsed = Object.fromEntries(new URLSearchParams(body));
      done(null, parsed);
    } catch (err) {
      done(err);
    }
  });

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

  // Initialize scheduler (BDA absent polling lives on main flashfire-website-backend only)
  const scheduler = new UnifiedScheduler({
    callHandler,
    whatsAppHandler,
    discordReminderHandler,
    bdaHandler: null,
    logger,
  });

  // Register routes
  const routeOpts = { scheduler, callHandler, whatsAppHandler, discordReminderHandler, discordService, startTime };
  await app.register(healthRoutes, routeOpts);
  await app.register(webhookRoutes, routeOpts);
  await app.register(debugRoutes, routeOpts);

  // Root
  app.get('/', async () => ({
    service: 'microservice-arc',
    version: '1.0.0',
    status: 'running',
    purpose: 'Precision reminders: Calls, WhatsApp, Discord (BDA attendance on main backend)',
  }));

  // Store references for shutdown
  app.decorate('scheduler', scheduler);

  return app;
}

async function start() {
  try {
    // 1. Connect to MongoDB
    await connect();
    logger.info('MongoDB connected');

    // 2. Build Fastify app
    const app = await buildApp();

    // 3. Start scheduler (preloads timers from DB)
    await app.scheduler.start();
    logger.info('UnifiedScheduler started — timers preloaded');

    // 4. Listen
    const port = env.PORT;
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, `Microservice-ARC running on port ${port}`);

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down...');
      await app.scheduler.stop();
      await app.close();
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
