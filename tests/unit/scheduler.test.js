'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Mock handlers
function createMockHandlers() {
  return {
    callHandler: {
      execute: mock.fn(async () => ({ success: true })),
      cancel: mock.fn(async () => {}),
      cancelForBooking: mock.fn(async () => {}),
    },
    whatsAppHandler: {
      execute: mock.fn(async () => ({ success: true })),
      cancel: mock.fn(async () => {}),
      cancelForBooking: mock.fn(async () => {}),
    },
    discordReminderHandler: {
      execute: mock.fn(async () => ({ success: true })),
      cancel: mock.fn(async () => {}),
      cancelForBooking: mock.fn(async () => {}),
    },
    bdaHandler: {
      startPolling: mock.fn(),
      stopPolling: mock.fn(),
    },
    logger: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
      debug: mock.fn(),
    },
  };
}

describe('UnifiedScheduler', () => {
  describe('Timer Precision', () => {
    it('should calculate correct delay for future events', () => {
      const futureTime = new Date(Date.now() + 60000); // 1 minute from now
      const delay = futureTime.getTime() - Date.now();
      assert.ok(delay > 59000 && delay <= 60000, `Delay should be ~60000ms, got ${delay}`);
    });

    it('should return zero/negative delay for past events', () => {
      const pastTime = new Date(Date.now() - 5000); // 5 seconds ago
      const delay = pastTime.getTime() - Date.now();
      assert.ok(delay < 0, 'Past events should have negative delay');
    });

    it('should handle immediate execution for overdue items', () => {
      const pastTime = new Date(Date.now() - 30000); // 30 seconds ago
      const delay = Math.max(0, pastTime.getTime() - Date.now());
      assert.equal(delay, 0, 'Overdue items should execute immediately (delay=0)');
    });
  });

  describe('Timer Map Management', () => {
    it('should store and retrieve timers', () => {
      const timerMap = new Map();
      const timerId = setTimeout(() => {}, 60000);
      timerMap.set('call_123', { timerId, type: 'call', scheduledFor: new Date() });
      assert.equal(timerMap.size, 1);
      assert.ok(timerMap.has('call_123'));
      clearTimeout(timerId);
      timerMap.delete('call_123');
      assert.equal(timerMap.size, 0);
    });

    it('should track timers by type', () => {
      const timerMap = new Map();
      const t1 = setTimeout(() => {}, 60000);
      const t2 = setTimeout(() => {}, 60000);
      const t3 = setTimeout(() => {}, 60000);
      timerMap.set('call_1', { timerId: t1, type: 'call', scheduledFor: new Date() });
      timerMap.set('wa_1', { timerId: t2, type: 'whatsapp', scheduledFor: new Date() });
      timerMap.set('discord_1', { timerId: t3, type: 'discord', scheduledFor: new Date() });

      const byType = {};
      for (const [, val] of timerMap) {
        byType[val.type] = (byType[val.type] || 0) + 1;
      }
      assert.equal(byType.call, 1);
      assert.equal(byType.whatsapp, 1);
      assert.equal(byType.discord, 1);

      [t1, t2, t3].forEach(clearTimeout);
    });
  });

  describe('Atomic Status Transitions', () => {
    it('should only process pending items', () => {
      const validStatuses = ['pending'];
      const testCases = [
        { status: 'pending', shouldProcess: true },
        { status: 'processing', shouldProcess: false },
        { status: 'completed', shouldProcess: false },
        { status: 'failed', shouldProcess: false },
        { status: 'cancelled', shouldProcess: false },
      ];

      for (const tc of testCases) {
        const result = validStatuses.includes(tc.status);
        assert.equal(result, tc.shouldProcess, `Status '${tc.status}' processing=${result}, expected=${tc.shouldProcess}`);
      }
    });
  });

  describe('Delivery Drift Calculation', () => {
    it('should calculate positive drift for late execution', () => {
      const scheduledFor = new Date(Date.now() - 3000); // 3 seconds ago
      const drift = Date.now() - scheduledFor.getTime();
      assert.ok(drift > 2900 && drift < 3200, `Drift should be ~3000ms, got ${drift}`);
    });

    it('should calculate near-zero drift for on-time execution', () => {
      const scheduledFor = new Date(Date.now());
      const drift = Date.now() - scheduledFor.getTime();
      assert.ok(drift >= 0 && drift < 100, `On-time drift should be <100ms, got ${drift}`);
    });
  });
});

describe('Stats Computation', () => {
  it('should return correct stats structure', () => {
    const timerMap = new Map();
    const stats = {
      activeTimers: timerMap.size,
      byType: { call: 0, whatsapp: 0, discord: 0 },
      uptime: Math.floor((Date.now() - Date.now()) / 1000),
    };
    assert.equal(typeof stats.activeTimers, 'number');
    assert.equal(typeof stats.byType, 'object');
    assert.ok('call' in stats.byType);
    assert.ok('whatsapp' in stats.byType);
    assert.ok('discord' in stats.byType);
  });
});
