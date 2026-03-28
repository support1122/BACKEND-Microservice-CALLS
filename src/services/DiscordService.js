'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const CircuitBreaker = require('./CircuitBreaker');
const env = require('../config/env');

class DiscordService {
  /**
   * @param {object} [webhookUrls] - Map of channel names to Discord webhook URLs
   */
  constructor(webhookUrls) {
    this.webhooks = webhookUrls ?? {
      hotLead: env.DISCORD_HOT_LEAD_WEBHOOK_URL,
      call: env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
      meet2min: env.DISCORD_MEET_2MIN_WEBHOOK_URL,
      bdaAttendance: env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL,
      bdaAbsent: env.DISCORD_BDA_ABSENT_WEBHOOK_URL,
      bdaDuration: env.DISCORD_BDA_DURATION_WEBHOOK_URL,
    };

    this.breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30_000 });

    logger.info('DiscordService initialised');
  }

  /* ------------------------------------------------------------------ */
  /*  Core send                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Send a message (and optional embeds) to a named webhook channel.
   *
   * @param {string}  channel  - Key in the webhooks map
   * @param {string}  message  - Plain-text content
   * @param {Array}   [embeds] - Discord embed objects
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async send(channel, message, embeds) {
    const url = this.webhooks[channel];

    if (!url) {
      const err = `DiscordService: unknown channel "${channel}"`;
      logger.error(err);
      return { success: false, error: err };
    }

    const payload = { content: message };
    if (embeds && embeds.length) payload.embeds = embeds;

    try {
      await this.breaker.execute(() =>
        axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        }),
      );

      logger.info({ channel }, 'Discord message sent');
      return { success: true };
    } catch (err) {
      const isCircuitOpen = err.message?.includes('OPEN');
      if (isCircuitOpen) {
        logger.warn({ channel }, 'Discord circuit breaker open — message skipped');
      } else {
        logger.error({ channel, err: err.message }, 'Discord send failed');
      }
      return { success: false, error: err.message };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Formatted helpers                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Send a hot-lead meeting notification to the 'hotLead' channel.
   * BDA team can confirm attendance by replying.
   */
  async sendMeetReminder({ clientName, meetingTime, meetingLink, minutesUntil }) {
    const message = [
      `\u{1F525} **Hot Lead \u2014 Meeting in ~${minutesUntil} minutes**`,
      ``,
      `**Client:** ${clientName}`,
      `**Time:** ${meetingTime}`,
      `**Link:** ${meetingLink}`,
      ``,
      `BDA team, confirm attendance by typing **"I'm in."** Let's close this.`,
    ].join('\n');

    return this.send('hotLead', message);
  }

  /**
   * Send a call-status update to the 'call' channel.
   */
  async sendCallStatus({ phoneNumber, callSid, status, inviteeName }) {
    const message = [
      `\u{1F4DE} **Call Status Update**`,
      `\u{1F464} Invitee: ${inviteeName}`,
      `\u{1F4F1} Phone: ${phoneNumber}`,
      `\u{1F194} SID: \`${callSid}\``,
      `\u{1F4CB} Status: **${status}**`,
    ].join('\n');

    return this.send('call', message);
  }

  /**
   * Send a BDA-absent alert to the 'bdaAbsent' channel (red embed).
   */
  async sendBdaAbsent({ bookingId, bdaEmail, meetingStart, clientName }) {
    const embed = {
      title: '\u{274C} BDA Absent',
      color: 0xff0000, // red
      fields: [
        { name: 'Booking', value: bookingId, inline: true },
        { name: 'BDA', value: bdaEmail, inline: true },
        { name: 'Client', value: clientName, inline: true },
        { name: 'Meeting Start', value: meetingStart, inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    return this.send('bdaAbsent', null, [embed]);
  }

  /**
   * Send a BDA-present notification to the 'bdaAttendance' channel (green embed).
   */
  async sendBdaPresent({ bookingId, bdaEmail, meetingStart, clientName }) {
    const embed = {
      title: '\u{2705} BDA Present',
      color: 0x00ff00, // green
      fields: [
        { name: 'Booking', value: bookingId, inline: true },
        { name: 'BDA', value: bdaEmail, inline: true },
        { name: 'Client', value: clientName, inline: true },
        { name: 'Meeting Start', value: meetingStart, inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    return this.send('bdaAttendance', null, [embed]);
  }
}

module.exports = DiscordService;
