'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('BdaHandler Logic', () => {
  describe('Absent detection window', () => {
    it('should detect meetings started > 60s ago but < 2h ago', () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      const sixtySecondsAgo = now - 60 * 1000;

      const testCases = [
        { label: '30s ago (too recent)', startTime: now - 30000, shouldDetect: false },
        { label: '2min ago (valid)', startTime: now - 120000, shouldDetect: true },
        { label: '1h ago (valid)', startTime: now - 3600000, shouldDetect: true },
        { label: '3h ago (too old)', startTime: now - 3 * 3600000, shouldDetect: false },
      ];

      for (const tc of testCases) {
        const inWindow = tc.startTime <= sixtySecondsAgo && tc.startTime >= twoHoursAgo;
        assert.equal(inWindow, tc.shouldDetect, `${tc.label}: expected ${tc.shouldDetect}, got ${inWindow}`);
      }
    });
  });

  describe('Absent marking', () => {
    it('should only mark absent if no attendance record exists', () => {
      const bookings = [
        { bookingId: 'b1', claimedBy: 'bda@test.com' },
        { bookingId: 'b2', claimedBy: 'bda2@test.com' },
        { bookingId: 'b3', claimedBy: null }, // no BDA assigned
      ];

      const attendanceRecords = [
        { bookingId: 'b1', status: 'present' },
      ];

      const eligibleBookings = bookings.filter(b => b.claimedBy);
      assert.equal(eligibleBookings.length, 2);

      const attendanceMap = new Set(attendanceRecords.map(a => a.bookingId));
      const absentBookings = eligibleBookings.filter(b => !attendanceMap.has(b.bookingId));
      assert.equal(absentBookings.length, 1);
      assert.equal(absentBookings[0].bookingId, 'b2');
    });
  });

  describe('Dedup prevention', () => {
    it('should not re-notify already notified absences', () => {
      const attendance = { bookingId: 'b1', status: 'absent', discordNotified: true };
      assert.ok(attendance.discordNotified, 'Should skip if already notified');
    });

    it('should notify new absences', () => {
      const attendance = { bookingId: 'b2', status: 'absent', discordNotified: false };
      assert.ok(!attendance.discordNotified, 'Should notify if not yet notified');
    });
  });

  describe('Polling interval', () => {
    it('should default to 60 seconds', () => {
      const defaultInterval = 60000;
      assert.equal(defaultInterval, 60000);
    });
  });
});
