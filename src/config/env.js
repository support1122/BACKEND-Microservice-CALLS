'use strict';

const path = require('path');

// Load local .env first (when microservice is standalone), fallback to parent's .env
const localEnv = path.resolve(__dirname, '../../.env');
const parentEnv = path.resolve(__dirname, '../../../../.env');
const fs = require('fs');

require('dotenv').config({
  path: fs.existsSync(localEnv) ? localEnv : parentEnv,
});

module.exports = {
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: parseInt(process.env.PORT, 10) || 4000,

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM: process.env.TWILIO_FROM,

  WATI_API_BASE_URL: process.env.WATI_API_BASE_URL,
  WATI_API_TOKEN: process.env.WATI_API_TOKEN,
  WATI_TENANT_ID: process.env.WATI_TENANT_ID,
  WATI_CHANNEL_NUMBER: process.env.WATI_CHANNEL_NUMBER,

  DISCORD_HOT_LEAD_WEBHOOK_URL: process.env.DISCORD_HOT_LEAD_WEBHOOK_URL,
  DISCORD_REMINDER_CALL_WEBHOOK_URL: process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
  DISCORD_MEET_2MIN_WEBHOOK_URL: process.env.DISCORD_MEET_2MIN_WEBHOOK_URL,
  DISCORD_BDA_ATTENDANCE_WEBHOOK_URL: process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL,
  DISCORD_BDA_ABSENT_WEBHOOK_URL: process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL,
  DISCORD_BDA_DURATION_WEBHOOK_URL: process.env.DISCORD_BDA_DURATION_WEBHOOK_URL,

  DISCORD_MEET_REMINDER_OFFSET_MINUTES: parseInt(process.env.DISCORD_MEET_REMINDER_OFFSET_MINUTES, 10) || 5,
  UNIFIED_SCHEDULER_POLL_MS: parseInt(process.env.UNIFIED_SCHEDULER_POLL_MS, 10) || 30000,
  SCHEDULER_STUCK_PROCESSING_MS: parseInt(process.env.SCHEDULER_STUCK_PROCESSING_MS, 10) || 120000,
  REMINDER_DRIFT_WARN_MS: parseInt(process.env.REMINDER_DRIFT_WARN_MS, 10) || 5000,

  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || null,

  NODE_ENV: process.env.NODE_ENV || 'development',
};
