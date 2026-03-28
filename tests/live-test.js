'use strict';

/**
 * LIVE TEST SCRIPT — Tests real integrations:
 * 1. Twilio call to +919866855857
 * 2. 3x WhatsApp reminders via WATI (immediate)
 * 3. Discord BDA absent notification
 * 4. Discord meeting reminder
 *
 * Run: node tests/live-test.js
 */

const env = require('../src/config/env');
const { connect, disconnect } = require('../src/db/connection');
const TwilioService = require('../src/services/TwilioService');
const WatiService = require('../src/services/WatiService');
const DiscordService = require('../src/services/DiscordService');

const TEST_PHONE = '+919866855857';
const TEST_NAME = 'Live Test Client';
const TEST_EMAIL = 'test@flashfirejobs.com';
const MEETING_TIME = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min from now

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('\n========================================');
  console.log('  MICROSERVICE-ARC LIVE TEST');
  console.log('========================================\n');

  // Connect to MongoDB
  console.log('[1/6] Connecting to MongoDB...');
  await connect();
  console.log('  ✅ MongoDB connected\n');

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

  const results = {};

  // --- TEST 1: Twilio Call ---
  console.log(`[2/6] Making Twilio call to ${TEST_PHONE}...`);
  try {
    const callResult = await twilioService.makeCall({
      to: TEST_PHONE,
      meetingTime: MEETING_TIME,
      meetingLink: 'https://meet.google.com/test-live',
      inviteeName: TEST_NAME,
      statusCallbackUrl: 'https://api.flashfirejobs.com/call-status',
      ivrUrl: 'https://api.flashfirejobs.com/twilio-ivr',
    });
    results.call = callResult;
    if (callResult.success) {
      console.log(`  ✅ Call initiated! SID: ${callResult.callSid}`);
    } else {
      console.log(`  ❌ Call failed: ${callResult.error}`);
    }
  } catch (err) {
    console.log(`  ❌ Call error: ${err.message}`);
    results.call = { success: false, error: err.message };
  }

  await sleep(1000);

  // --- TEST 2: WhatsApp Reminders (3x) ---
  console.log(`\n[3/6] Sending 3 WhatsApp reminders to ${TEST_PHONE}...`);
  const waTypes = ['5min', '2hour', '24hour'];
  results.whatsapp = [];

  for (const type of waTypes) {
    try {
      console.log(`  Sending ${type} reminder...`);
      // Use the SAME template name as the parent app: 'flashfire_appointment_reminder'
      // Parameters: {{1}}=name, {{2}}=date, {{3}}=time+timezone, {{4}}=meeting link, {{5}}=reschedule link
      const waResult = await watiService.sendTemplateMessage({
        phoneNumber: TEST_PHONE,
        templateName: 'flashfire_appointment_reminder',
        parameters: [
          TEST_NAME,                           // {{1}} name
          'March 28, 2026',                    // {{2}} date
          `3:30 PM - 4:00 PM IST (${type})`,  // {{3}} time + timezone
          'https://meet.google.com/test-live', // {{4}} meeting link
          'https://calendly.com/reschedule/test', // {{5}} reschedule link
        ],
      });
      results.whatsapp.push({ type, ...waResult });
      if (waResult.success) {
        console.log(`  ✅ ${type} WhatsApp sent`);
      } else {
        console.log(`  ❌ ${type} WhatsApp failed: ${waResult.error}`);
      }
    } catch (err) {
      console.log(`  ❌ ${type} WhatsApp error: ${err.message}`);
      results.whatsapp.push({ type, success: false, error: err.message });
    }
    await sleep(500);
  }

  // --- TEST 3: Discord Meeting Reminder ---
  console.log('\n[4/6] Sending Discord meeting reminder...');
  try {
    const discordMeet = await discordService.sendMeetReminder({
      clientName: TEST_NAME,
      meetingTime: 'Mar 28, 2026, 3:30 PM',
      meetingLink: 'https://meet.google.com/test-live',
      minutesUntil: 5,
    });
    results.discordMeet = discordMeet;
    console.log(`  ${discordMeet.success ? '✅' : '❌'} Discord meeting reminder: ${discordMeet.success ? 'sent' : discordMeet.error}`);
  } catch (err) {
    console.log(`  ❌ Discord meet error: ${err.message}`);
    results.discordMeet = { success: false, error: err.message };
  }

  await sleep(500);

  // --- TEST 4: Discord BDA Absent ---
  console.log('\n[5/6] Sending Discord BDA absent notification...');
  try {
    const discordBda = await discordService.sendBdaAbsent({
      bookingId: 'test_booking_live_001',
      bdaEmail: 'bda-test@flashfirejobs.com',
      clientName: TEST_NAME,
      meetingStart: new Date().toISOString(),
    });
    results.discordBda = discordBda;
    console.log(`  ${discordBda.success ? '✅' : '❌'} Discord BDA absent: ${discordBda.success ? 'sent' : discordBda.error}`);
  } catch (err) {
    console.log(`  ❌ Discord BDA error: ${err.message}`);
    results.discordBda = { success: false, error: err.message };
  }

  await sleep(500);

  // --- TEST 5: Discord Call Status ---
  console.log('\n[6/6] Sending Discord call status notification...');
  try {
    const discordCall = await discordService.sendCallStatus({
      phoneNumber: TEST_PHONE,
      callSid: results.call?.callSid || 'TEST_SID_123',
      status: 'completed',
      inviteeName: TEST_NAME,
    });
    results.discordCall = discordCall;
    console.log(`  ${discordCall.success ? '✅' : '❌'} Discord call status: ${discordCall.success ? 'sent' : discordCall.error}`);
  } catch (err) {
    console.log(`  ❌ Discord call status error: ${err.message}`);
    results.discordCall = { success: false, error: err.message };
  }

  // --- SUMMARY ---
  console.log('\n========================================');
  console.log('  RESULTS SUMMARY');
  console.log('========================================');
  console.log(`  Twilio Call:          ${results.call?.success ? '✅ PASS' : '❌ FAIL'} ${results.call?.callSid || results.call?.error || ''}`);
  for (const wa of results.whatsapp) {
    console.log(`  WhatsApp ${wa.type.padEnd(6)}:     ${wa.success ? '✅ PASS' : '❌ FAIL'} ${wa.error || ''}`);
  }
  console.log(`  Discord Meet:         ${results.discordMeet?.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Discord BDA Absent:   ${results.discordBda?.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Discord Call Status:  ${results.discordCall?.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log('========================================\n');

  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
