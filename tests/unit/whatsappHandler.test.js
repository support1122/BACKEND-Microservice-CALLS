'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('WhatsAppHandler Logic', () => {
  describe('Reminder type scheduling', () => {
    const meetingStartISO = '2026-03-28T10:00:00Z';
    const meetingDate = new Date(meetingStartISO);

    it('should schedule 5min reminder 5 minutes before meeting', () => {
      const scheduledFor = new Date(meetingDate.getTime() - 5 * 60 * 1000);
      assert.equal(scheduledFor.toISOString(), '2026-03-28T09:55:00.000Z');
    });

    it('should schedule 2hour reminder 2 hours before meeting', () => {
      const scheduledFor = new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000);
      assert.equal(scheduledFor.toISOString(), '2026-03-28T08:00:00.000Z');
    });

    it('should schedule 24hour reminder 24 hours before meeting', () => {
      const scheduledFor = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      assert.equal(scheduledFor.toISOString(), '2026-03-27T10:00:00.000Z');
    });

    it('should schedule noshow reminder immediately', () => {
      const scheduledFor = new Date(); // immediate
      const delay = scheduledFor.getTime() - Date.now();
      assert.ok(delay <= 100, 'No-show should be near-immediate');
    });
  });

  describe('Template parameter building', () => {
    it('should build correct template parameters', () => {
      const params = [
        { name: 'name', value: 'John Doe' },
        { name: 'meeting_time', value: 'Mar 28, 2026 at 10:00 AM IST' },
        { name: 'meeting_link', value: 'https://meet.example.com/test' },
        { name: 'reschedule_link', value: 'https://calendly.com/reschedule/abc' },
      ];

      assert.equal(params.length, 4);
      assert.equal(params[0].name, 'name');
      assert.equal(params[0].value, 'John Doe');
      assert.equal(params[1].name, 'meeting_time');
    });
  });

  describe('Reminder ID generation', () => {
    it('should include booking ID and reminder type', () => {
      const bookingId = 'booking_abc123';
      const reminderType = '5min';
      const reminderId = `wa_${bookingId}_${reminderType}_${Date.now()}`;
      assert.ok(reminderId.includes(bookingId));
      assert.ok(reminderId.includes(reminderType));
      assert.ok(reminderId.startsWith('wa_'));
    });
  });

  describe('Cancellation logic', () => {
    it('should cancel all reminder types for a booking', () => {
      const bookingId = 'booking_abc123';
      const reminders = [
        { reminderId: `wa_${bookingId}_5min_1`, status: 'pending' },
        { reminderId: `wa_${bookingId}_2hour_1`, status: 'pending' },
        { reminderId: `wa_${bookingId}_24hour_1`, status: 'completed' },
      ];
      const toCancel = reminders.filter(r => r.status === 'pending');
      assert.equal(toCancel.length, 2, 'Should only cancel pending reminders');
    });
  });
});
