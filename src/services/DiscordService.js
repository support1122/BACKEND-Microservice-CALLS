'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const CircuitBreaker = require('./CircuitBreaker');
const env = require('../config/env');

const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  /*  Core send with retry + rate-limit handling                         */
  /* ------------------------------------------------------------------ */

  /**
   * Send a message (and optional embeds) to a named webhook channel.
   * Retries on 429 (rate-limit) and 5xx errors with exponential backoff.
   *
   * @param {string}  channel  - Key in the webhooks map
   * @param {string}  message  - Plain-text content (can be null if embeds provided)
   * @param {Array}   [embeds] - Discord embed objects
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async send(channel, message, embeds) {
    const url = this.webhooks[channel];

    if (!url) {
      const err = `DiscordService: unknown channel "${channel}" — check env config`;
      logger.error(err);
      return { success: false, error: err };
    }

    // Build payload — omit content key entirely when null to avoid Discord rejection
    const DISCORD_MAX_CHARS = 2000;
    const payload = {};
    if (message != null && message !== '') {
      let content = String(message);
      if (content.length > DISCORD_MAX_CHARS) {
        content = content.slice(0, DISCORD_MAX_CHARS - 15) + '\n…[truncated]';
      }
      payload.content = content;
    }
    if (embeds && embeds.length) {
      payload.embeds = embeds;
    }

    // Must have at least content or embeds
    if (!payload.content && !payload.embeds) {
      const err = 'DiscordService: message and embeds are both empty';
      logger.warn({ channel }, err);
      return { success: false, error: err };
    }

    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.breaker.execute(() =>
          axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10_000,
          }),
        );

        logger.info({ channel, attempt }, 'Discord message sent');
        return { success: true };
      } catch (err) {
        lastError = err;
        const isCircuitOpen = err.message?.includes('OPEN');

        if (isCircuitOpen) {
          logger.warn({ channel }, 'Discord circuit breaker open — message skipped');
          return { success: false, error: 'Circuit breaker OPEN' };
        }

        // Handle rate limiting (429) and server errors (5xx) with retry
        const status = err.response?.status;
        if (status === 429 || (status >= 500 && status < 600)) {
          // Parse Retry-After header
          const retryAfter = err.response?.headers?.['retry-after'];
          let waitMs = 2000 * (attempt + 1); // default exponential backoff
          if (retryAfter) {
            const parsed = parseFloat(retryAfter);
            if (!isNaN(parsed)) {
              waitMs = Math.ceil(parsed * 1000) + 500; // add 500ms buffer
            }
          }
          logger.warn({ channel, status, waitMs, attempt }, `Discord ${status} — retrying in ${waitMs}ms`);

          if (attempt < MAX_RETRIES - 1) {
            await sleep(waitMs);
            continue;
          }
        }

        // DNS/network errors — retry with backoff
        if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
          logger.warn({ channel, code: err.code, attempt }, `Discord network error — retrying`);
          if (attempt < MAX_RETRIES - 1) {
            await sleep(2000 * (attempt + 1));
            continue;
          }
        }

        logger.error({ channel, err: err.message, status }, 'Discord send failed');
      }
    }

    logger.error({ channel, err: lastError?.message }, `Discord send failed after ${MAX_RETRIES} retries`);
    return { success: false, error: lastError?.message || 'Unknown error' };
  }

  /* ------------------------------------------------------------------ */
  /*  Formatted helpers                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Send a hot-lead meeting notification to the 'hotLead' channel.
   * BDA team can confirm attendance by replying.
   *
   * If meetingTime / meetingTimeIndia are missing or "Unknown", we omit those
   * lines and fall back to the simpler "your meet is in ~5 minutes" headline
   * — never print "Time (Client): Unknown".
   */
  async sendMeetReminder({ clientName, meetingTime, meetingTimeIndia, meetingLink, minutesUntil, claimedBy }) {
    const claimedLine = claimedBy
      ? `**Assigned BDA:** ${claimedBy}`
      : '\u26A0\uFE0F **NOT CLAIMED**';

    const isUsable = (v) =>
      v != null && v !== '' && v !== 'Unknown' && !String(v).startsWith('Unknown') && v !== 'undefined';

    const minutesLabel = Number.isFinite(minutesUntil) && minutesUntil > 0 ? minutesUntil : 5;

    const lines = [
      `\u{1F525} **Hot Lead \u2014 Meeting in ~${minutesLabel} minutes**`,
      ``,
      `**Client:** ${clientName || 'Unknown client'}`,
    ];

    if (isUsable(meetingTime)) {
      lines.push(`**Time (Client):** ${meetingTime}`);
    }
    if (isUsable(meetingTimeIndia)) {
      lines.push(`**Time (India):** ${meetingTimeIndia}`);
    }

    lines.push(
      `**Link:** ${meetingLink || 'Not provided'}`,
      claimedLine,
      ``,
      `BDA team, confirm attendance by typing **"I'm in."** Let's close this.`,
    );

    return this.send('meet2min', lines.join('\n'));
  }

  /**
   * Send a call-status update to the 'call' channel.
   * Matches the detailed format expected by the team.
   */
  async sendCallStatus({
    phoneNumber, callSid, status, inviteeName,
    fromNumber, answeredBy, duration, timestamp,
    inviteeEmail, meetingTime,
  }) {
    const statusDate = timestamp
      ? new Date(timestamp).toUTCString()
      : new Date().toUTCString();

    const lines = [
      `\u{1F6A8} **App Update: ${status}**`,
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      `\u{1F4DE} **To:** ${phoneNumber || 'Unknown'}`,
      `\u{1F464} **From:** ${fromNumber || 'Unknown'}`,
    ];

    if (inviteeName && inviteeName !== 'Unknown') {
      lines.push(`\u{1F464} **Name:** ${inviteeName}`);
    }

    lines.push(`\u{1F464} **Status:** ${status}`);
    lines.push(`\u{1F464} **Answered By:** ${answeredBy || 'Unknown'}`);

    if (duration) {
      lines.push(`\u23F1\uFE0F **Duration:** ${duration} seconds`);
    }

    lines.push(`\u{1F464} **Call SID:** ${callSid}`);
    lines.push(`\u{1F464} **Timestamp:** ${statusDate}`);

    if (inviteeEmail && inviteeEmail !== 'Unknown') {
      lines.push(`\u{1F4E7} **Email:** ${inviteeEmail}`);
    }

    if (meetingTime && meetingTime !== 'Unknown') {
      lines.push(`\u{1F4C6} **Meeting:** ${meetingTime}`);
    }

    lines.push(`\u{1F3AB} **Twilio SID:** ${callSid}`);
    lines.push(`\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`);

    return this.send('call', lines.join('\n'));
  }

  /**
   * Ensure embed field values are non-empty strings (Discord rejects empty/null values).
   */
  _safeField(value) {
    if (value == null || value === '') return 'N/A';
    if (typeof value === 'object') {
      // Extract meaningful field from objects (e.g. claimedBy: { email, name, claimedAt })
      return value.email || value.name || value.bdaEmail || value.bdaName || JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Send a BDA-absent alert to the 'bdaAbsent' channel (red embed).
   */
  async sendBdaAbsent({ bookingId, bdaEmail, meetingStart, clientName }) {
    const embed = {
      title: '\u{274C} BDA Absent',
      color: 0xff0000, // red
      fields: [
        { name: 'Booking', value: this._safeField(bookingId), inline: true },
        { name: 'BDA', value: this._safeField(bdaEmail), inline: true },
        { name: 'Client', value: this._safeField(clientName), inline: true },
        { name: 'Meeting Start', value: this._safeField(meetingStart), inline: false },
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
        { name: 'Booking', value: this._safeField(bookingId), inline: true },
        { name: 'BDA', value: this._safeField(bdaEmail), inline: true },
        { name: 'Client', value: this._safeField(clientName), inline: true },
        { name: 'Meeting Start', value: this._safeField(meetingStart), inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    return this.send('bdaAttendance', null, [embed]);
  }

  /**
   * Send a BDA meeting duration report to the 'bdaDuration' channel (blue embed).
   * Shows how long the BDA spent in the meeting.
   */
  async sendBdaDuration({ bookingId, bdaEmail, clientName, meetingStart, durationMinutes, joinedAt, leftAt }) {
    const durationDisplay = durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
      : `${durationMinutes}m`;

    const color = durationMinutes >= 15 ? 0x00ff00 : durationMinutes >= 5 ? 0xffaa00 : 0xff0000;

    const embed = {
      title: '\u{23F1}\uFE0F BDA Meeting Duration',
      color,
      fields: [
        { name: 'Booking', value: this._safeField(bookingId), inline: true },
        { name: 'BDA', value: this._safeField(bdaEmail), inline: true },
        { name: 'Client', value: this._safeField(clientName), inline: true },
        { name: 'Meeting Start', value: this._safeField(meetingStart), inline: true },
        { name: 'Duration', value: durationDisplay, inline: true },
        { name: 'Joined At', value: this._safeField(joinedAt), inline: true },
        { name: 'Left At', value: this._safeField(leftAt), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    return this.send('bdaDuration', null, [embed]);
  }
}

module.exports = DiscordService;
