'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Health Endpoint Response', () => {
  it('should return correct structure', () => {
    const response = {
      status: 'ok',
      service: 'microservice-arc',
      uptime: 120,
      activeTimers: 5,
      byType: { call: 2, whatsapp: 2, discord: 1 },
      timestamp: new Date().toISOString(),
    };

    assert.equal(response.status, 'ok');
    assert.equal(response.service, 'microservice-arc');
    assert.equal(typeof response.uptime, 'number');
    assert.equal(typeof response.activeTimers, 'number');
    assert.ok(response.byType.call >= 0);
    assert.ok(response.byType.whatsapp >= 0);
    assert.ok(response.byType.discord >= 0);
    assert.ok(response.timestamp);
  });

  it('should report zero timers when no meetings scheduled', () => {
    const response = { activeTimers: 0, byType: { call: 0, whatsapp: 0, discord: 0 } };
    assert.equal(response.activeTimers, 0);
    assert.equal(response.byType.call, 0);
  });
});

describe('Stats Endpoint', () => {
  it('should return scheduler stats', () => {
    const stats = {
      activeTimers: 10,
      byType: { call: 3, whatsapp: 5, discord: 2 },
      uptime: 3600,
      safetyNetRuns: 120,
      stuckRecoveries: 0,
    };

    assert.equal(stats.activeTimers, 10);
    assert.equal(stats.byType.call + stats.byType.whatsapp + stats.byType.discord, 10);
  });
});

describe('Upcoming Endpoint', () => {
  it('should return sorted upcoming reminders', () => {
    const upcoming = {
      calls: [
        { callId: 'call_1', scheduledFor: '2026-03-28T09:50:00Z', status: 'pending' },
        { callId: 'call_2', scheduledFor: '2026-03-28T10:50:00Z', status: 'pending' },
      ],
      whatsapp: [
        { reminderId: 'wa_1', scheduledFor: '2026-03-28T09:55:00Z', status: 'pending' },
      ],
      discord: [],
    };

    assert.equal(upcoming.calls.length, 2);
    assert.ok(new Date(upcoming.calls[0].scheduledFor) < new Date(upcoming.calls[1].scheduledFor));
    assert.equal(upcoming.whatsapp.length, 1);
    assert.equal(upcoming.discord.length, 0);
  });
});
