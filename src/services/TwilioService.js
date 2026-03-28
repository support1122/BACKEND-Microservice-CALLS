'use strict';

const twilio = require('twilio');
const logger = require('../utils/logger');
const CircuitBreaker = require('./CircuitBreaker');
const env = require('../config/env');

class TwilioService {
  constructor({
    accountSid = env.TWILIO_ACCOUNT_SID,
    authToken = env.TWILIO_AUTH_TOKEN,
    from = env.TWILIO_FROM,
  } = {}) {
    if (!accountSid || !authToken || !from) {
      throw new Error('TwilioService: missing required credentials (accountSid, authToken, from)');
    }

    this.from = from;
    this.client = twilio(accountSid, authToken);
    this.breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30_000 });

    logger.info('TwilioService initialised');
  }

  /**
   * Place an outbound call via Twilio.
   *
   * @param {object}  params
   * @param {string}  params.to                - E.164 phone number
   * @param {string}  params.meetingTime       - Human-readable meeting time (for logging)
   * @param {string}  params.meetingLink        - Meeting URL (for logging / IVR context)
   * @param {string}  params.inviteeName        - Invitee name
   * @param {string}  params.statusCallbackUrl  - Webhook for call status events
   * @param {string}  params.ivrUrl             - TwiML URL that controls call flow
   * @returns {Promise<{ success: boolean, callSid?: string, error?: string }>}
   */
  async makeCall({ to, meetingTime, meetingLink, inviteeName, statusCallbackUrl, ivrUrl }) {
    const ctx = { to, inviteeName, meetingTime };

    try {
      const call = await this.breaker.execute(() =>
        this.client.calls.create({
          to,
          from: this.from,
          url: ivrUrl,
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
          machineDetection: 'Enable',
        }),
      );

      logger.info({ ...ctx, callSid: call.sid }, 'Twilio call created');
      return { success: true, callSid: call.sid };
    } catch (err) {
      const isCircuitOpen = err.message?.includes('OPEN');
      if (isCircuitOpen) {
        logger.warn(ctx, 'Twilio circuit breaker open — call skipped');
      } else {
        logger.error({ ...ctx, err: err.message }, 'Twilio makeCall failed');
      }
      return { success: false, error: err.message };
    }
  }
}

module.exports = TwilioService;
