'use strict';

const ScheduledCall = require('../models/ScheduledCall');
const ScheduledWhatsAppReminder = require('../models/ScheduledWhatsAppReminder');
const ScheduledDiscordMeetReminder = require('../models/ScheduledDiscordMeetReminder');
const {
  UNIFIED_SCHEDULER_POLL_MS,
  SCHEDULER_STUCK_PROCESSING_MS,
} = require('../config/env');

class UnifiedScheduler {
  /**
   * @param {Object} deps
   * @param {Object} deps.callHandler
   * @param {Object} deps.whatsAppHandler
   * @param {Object} deps.discordReminderHandler
   * @param {Object|null} [deps.bdaHandler] Reserved / unused; BDA polling runs on main backend only
   * @param {Object} deps.logger
   */
  constructor({ callHandler, whatsAppHandler, discordReminderHandler, bdaHandler, logger }) {
    this._callHandler = callHandler;
    this._whatsAppHandler = whatsAppHandler;
    this._discordReminderHandler = discordReminderHandler;
    this._bdaHandler = bdaHandler || null;
    this._log = logger.child({ component: 'UnifiedScheduler' });

    /** @type {Map<string, { timerId: NodeJS.Timeout, type: string, scheduledFor: Date }>} */
    this._timers = new Map();
    this._pollInterval = null;
    this._startedAt = null;
    this._stopping = false;
    this._inFlight = new Set();
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                         */
  /* ------------------------------------------------------------------ */

  async start() {
    this._startedAt = Date.now();
    this._stopping = false;
    this._log.info('Starting UnifiedScheduler');

    await this._recoverStuck();
    await this._preloadTimers();

    this._pollInterval = setInterval(() => {
      this._safetyNetPoll().catch((err) =>
        this._log.error({ err }, 'Safety-net poll error'),
      );
      this._recoverStuck().catch((err) =>
        this._log.error({ err }, 'Stuck-recovery error'),
      );
    }, UNIFIED_SCHEDULER_POLL_MS);

    this._log.info(
      { activeTimers: this._timers.size },
      'UnifiedScheduler started',
    );
  }

  async stop() {
    this._stopping = true;
    this._log.info('Stopping UnifiedScheduler');

    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    for (const [key, entry] of this._timers) {
      clearTimeout(entry.timerId);
      this._timers.delete(key);
    }

    // Drain in-flight operations (wait up to 10 s)
    const deadline = Date.now() + 10_000;
    while (this._inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    this._log.info('UnifiedScheduler stopped');
  }

  /* ------------------------------------------------------------------ */
  /*  Public schedule / cancel API                                      */
  /* ------------------------------------------------------------------ */

  scheduleCall(callDoc) {
    this._setTimer('call', callDoc.callId, callDoc.scheduledFor, () =>
      this._callHandler.execute(callDoc),
    );
  }

  scheduleWhatsApp(reminderDoc) {
    this._setTimer('whatsapp', reminderDoc.reminderId, reminderDoc.scheduledFor, () =>
      this._whatsAppHandler.execute(reminderDoc),
    );
  }

  scheduleDiscordReminder(reminderDoc) {
    this._setTimer('discord', reminderDoc.reminderId, reminderDoc.scheduledFor, () =>
      this._discordReminderHandler.execute(reminderDoc),
    );
  }

  async cancelReminder(type, id) {
    const key = `${type}:${id}`;
    const entry = this._timers.get(key);
    if (entry) {
      clearTimeout(entry.timerId);
      this._timers.delete(key);
    }

    const model = this._modelForType(type);
    const idField = type === 'call' ? 'callId' : 'reminderId';
    await model.findOneAndUpdate(
      { [idField]: id, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );

    this._log.info({ type, id }, 'Reminder cancelled');
  }

  async cancelAllForBooking(bookingId) {
    const ops = [
      ScheduledCall.updateMany(
        { bookingId, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ),
      ScheduledWhatsAppReminder.updateMany(
        { bookingId, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ),
      ScheduledDiscordMeetReminder.updateMany(
        { bookingId, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ),
    ];

    await Promise.all(ops);

    // Remove timers that belong to this booking
    for (const [key] of this._timers) {
      if (key.includes(bookingId)) {
        const entry = this._timers.get(key);
        if (entry) clearTimeout(entry.timerId);
        this._timers.delete(key);
      }
    }

    this._log.info({ bookingId }, 'All reminders cancelled for booking');
  }

  /* ------------------------------------------------------------------ */
  /*  Core timer logic                                                  */
  /* ------------------------------------------------------------------ */

  _setTimer(type, id, scheduledFor, handler) {
    if (this._stopping) return;

    const key = `${type}:${id}`;
    const scheduledDate = new Date(scheduledFor);
    const delay = scheduledDate.getTime() - Date.now();

    const wrappedHandler = async () => {
      this._timers.delete(key);
      const trackingId = `${type}:${id}`;
      this._inFlight.add(trackingId);
      try {
        await handler();
      } catch (err) {
        this._log.error({ err, type, id }, 'Timer handler execution failed');
      } finally {
        this._inFlight.delete(trackingId);
      }
    };

    // Clear any existing timer for this key
    const existing = this._timers.get(key);
    if (existing) clearTimeout(existing.timerId);

    // Node setTimeout uses int32 ms; delays > ~24.85 days fire immediately.
    // Re-arm in chunks so far-future reminders wait until their real scheduledFor.
    const MAX_TIMEOUT_MS = 2_147_483_647;

    if (delay <= 0) {
      // Fire immediately
      this._timers.set(key, { timerId: null, type, scheduledFor: scheduledDate });
      wrappedHandler();
    } else if (delay > MAX_TIMEOUT_MS) {
      const timerId = setTimeout(() => {
        this._timers.delete(key);
        this._setTimer(type, id, scheduledFor, handler);
      }, MAX_TIMEOUT_MS);
      this._timers.set(key, { timerId, type, scheduledFor: scheduledDate });
    } else {
      const timerId = setTimeout(wrappedHandler, delay);
      this._timers.set(key, { timerId, type, scheduledFor: scheduledDate });
    }

    this._log.debug({ type, id, delayMs: Math.max(delay, 0) }, 'Timer set');
  }

  /* ------------------------------------------------------------------ */
  /*  Safety net & recovery                                             */
  /* ------------------------------------------------------------------ */

  async _safetyNetPoll() {
    const now = new Date();
    const query = { status: 'pending', scheduledFor: { $lte: now } };

    const [calls, waReminders, discordReminders] = await Promise.all([
      ScheduledCall.find(query).lean(),
      ScheduledWhatsAppReminder.find(query).lean(),
      ScheduledDiscordMeetReminder.find(query).lean(),
    ]);

    for (const call of calls) {
      if (!this._timers.has(`call:${call.callId}`)) {
        this._log.warn({ callId: call.callId }, 'Safety-net: processing missed call');
        this._setTimer('call', call.callId, call.scheduledFor, () =>
          this._callHandler.execute(call),
        );
      }
    }

    for (const wa of waReminders) {
      if (!this._timers.has(`whatsapp:${wa.reminderId}`)) {
        this._log.warn({ reminderId: wa.reminderId }, 'Safety-net: processing missed WA reminder');
        this._setTimer('whatsapp', wa.reminderId, wa.scheduledFor, () =>
          this._whatsAppHandler.execute(wa),
        );
      }
    }

    for (const disc of discordReminders) {
      if (!this._timers.has(`discord:${disc.reminderId}`)) {
        this._log.warn({ reminderId: disc.reminderId }, 'Safety-net: processing missed Discord reminder');
        this._setTimer('discord', disc.reminderId, disc.scheduledFor, () =>
          this._discordReminderHandler.execute(disc),
        );
      }
    }
  }

  async _recoverStuck() {
    const stuckThreshold = new Date(Date.now() - SCHEDULER_STUCK_PROCESSING_MS);
    const filter = { status: 'processing', updatedAt: { $lte: stuckThreshold } };
    const update = { $set: { status: 'pending' } };

    const [callResult, waResult, discordResult] = await Promise.all([
      ScheduledCall.updateMany(filter, update),
      ScheduledWhatsAppReminder.updateMany(filter, update),
      ScheduledDiscordMeetReminder.updateMany(filter, update),
    ]);

    const total =
      (callResult.modifiedCount || 0) +
      (waResult.modifiedCount || 0) +
      (discordResult.modifiedCount || 0);

    if (total > 0) {
      this._log.warn({ total }, 'Recovered stuck items back to pending');
    }
  }

  async _preloadTimers() {
    const query = { status: 'pending' };

    const [calls, waReminders, discordReminders] = await Promise.all([
      ScheduledCall.find(query).lean(),
      ScheduledWhatsAppReminder.find(query).lean(),
      ScheduledDiscordMeetReminder.find(query).lean(),
    ]);

    for (const call of calls) {
      this._setTimer('call', call.callId, call.scheduledFor, () =>
        this._callHandler.execute(call),
      );
    }

    for (const wa of waReminders) {
      this._setTimer('whatsapp', wa.reminderId, wa.scheduledFor, () =>
        this._whatsAppHandler.execute(wa),
      );
    }

    for (const disc of discordReminders) {
      this._setTimer('discord', disc.reminderId, disc.scheduledFor, () =>
        this._discordReminderHandler.execute(disc),
      );
    }

    this._log.info(
      {
        calls: calls.length,
        whatsapp: waReminders.length,
        discord: discordReminders.length,
      },
      'Preloaded timers',
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Stats                                                             */
  /* ------------------------------------------------------------------ */

  getStats() {
    const byType = { call: 0, whatsapp: 0, discord: 0 };
    for (const entry of this._timers.values()) {
      if (byType[entry.type] !== undefined) byType[entry.type]++;
    }

    return {
      activeTimers: this._timers.size,
      byType,
      uptime: this._startedAt ? Date.now() - this._startedAt : 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  _modelForType(type) {
    switch (type) {
      case 'call':
        return ScheduledCall;
      case 'whatsapp':
        return ScheduledWhatsAppReminder;
      case 'discord':
        return ScheduledDiscordMeetReminder;
      default:
        throw new Error(`Unknown reminder type: ${type}`);
    }
  }
}

module.exports = UnifiedScheduler;
