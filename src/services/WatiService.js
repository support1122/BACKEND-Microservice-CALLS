'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const CircuitBreaker = require('./CircuitBreaker');
const env = require('../config/env');

const TEMPLATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

class WatiService {
  constructor({
    baseUrl = env.WATI_API_BASE_URL,
    token = env.WATI_API_TOKEN,
    tenantId = env.WATI_TENANT_ID,
    channelNumber = env.WATI_CHANNEL_NUMBER,
  } = {}) {
    if (!baseUrl || !token) {
      throw new Error('WatiService: missing required config (baseUrl, token)');
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tenantId = tenantId;
    this.channelNumber = channelNumber;

    // Normalize token — remove 'Bearer ' if already present, we add it ourselves
    const rawToken = token.replace(/^Bearer\s+/i, '').trim();
    this.headers = {
      Authorization: `Bearer ${rawToken}`,
      'Content-Type': 'application/json',
    };

    this.templateCache = new Map();
    this.breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30_000 });

    logger.info('WatiService initialised');
  }

  /**
   * Send a WhatsApp template message via WATI.
   * Matches the parent app's WatiService API format exactly.
   *
   * @param {object}   params
   * @param {string}   params.phoneNumber   - Recipient phone (with or without +)
   * @param {string}   params.templateName  - WATI template name (e.g., 'flashfire_appointment_reminder')
   * @param {Array}    params.parameters    - Template parameter values (array of strings or [{name, value}])
   * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
   */
  async sendTemplateMessage({ phoneNumber, templateName, parameters = [] }) {
    const ctx = { phoneNumber, templateName };

    // Normalize phone — digits only
    const mobile = phoneNumber.replace(/\D/g, '');

    // Build URL with tenant ID (matches parent app's format)
    const basePath = this.tenantId
      ? `${this.baseUrl}/${this.tenantId}/api/v2/sendTemplateMessage`
      : `${this.baseUrl}/api/v2/sendTemplateMessage`;
    const url = `${basePath}?whatsappNumber=${mobile}`;

    // Normalize channel number: digits only, ensure starts with '91'
    let channelDigits = this.channelNumber ? this.channelNumber.replace(/\D/g, '') : '';
    if (channelDigits && !channelDigits.startsWith('91')) {
      channelDigits = `91${channelDigits}`;
    }

    // Format parameters as [{name: "1", value: "..."}, {name: "2", value: "..."}, ...]
    const formattedParameters = Array.isArray(parameters)
      ? parameters.map((p, idx) => {
          if (typeof p === 'object' && p.name) {
            // Already formatted with name/value — but WATI expects numeric names
            return { name: `${idx + 1}`, value: String(p.value || ' ') };
          }
          // Plain string value
          return { name: `${idx + 1}`, value: String(p || ' ') };
        })
      : [];

    const body = {
      template_name: templateName,
      broadcast_name: `reminder_${Date.now()}`,
      parameters: formattedParameters,
    };

    // Add channel number if available
    if (channelDigits) {
      body.channelNumber = channelDigits;
    }

    try {
      const { data } = await this.breaker.execute(() =>
        axios.post(url, body, {
          headers: this.headers,
          timeout: 10_000,
        }),
      );

      logger.info(ctx, 'WATI template message sent');
      return { success: true, data };
    } catch (err) {
      const isCircuitOpen = err.message?.includes('OPEN');
      if (isCircuitOpen) {
        logger.warn(ctx, 'WATI circuit breaker open — message skipped');
      } else {
        logger.error({ ...ctx, err: err.message, status: err.response?.status, responseData: err.response?.data }, 'WATI sendTemplateMessage failed');
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Fetch available templates from WATI (cached for 1 hour).
   */
  async getTemplates() {
    const cacheKey = 'templates';
    const cached = this.templateCache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < TEMPLATE_CACHE_TTL_MS) {
      return { success: true, data: cached.data };
    }

    const basePath = this.tenantId
      ? `${this.baseUrl}/${this.tenantId}/api/v1/getMessageTemplates`
      : `${this.baseUrl}/api/v1/getMessageTemplates`;

    try {
      const { data } = await this.breaker.execute(() =>
        axios.get(basePath, {
          headers: this.headers,
          timeout: 10_000,
        }),
      );

      this.templateCache.set(cacheKey, { data, cachedAt: Date.now() });
      logger.info('WATI templates fetched and cached');
      return { success: true, data };
    } catch (err) {
      logger.error({ err: err.message }, 'WATI getTemplates failed');
      return { success: false, error: err.message };
    }
  }
}

module.exports = WatiService;
