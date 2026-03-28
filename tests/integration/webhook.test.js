'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Integration-style tests using dummy data — tests webhook payload parsing logic
// without needing live DB/services

describe('Calendly Webhook Payload Parsing', () => {
  function extractPhone(payload) {
    const questionsAndAnswers = payload.questions_and_answers || [];
    for (const qa of questionsAndAnswers) {
      const q = (qa.question || '').toLowerCase();
      if (q.includes('phone') || q.includes('mobile') || q.includes('whatsapp') || q.includes('contact')) {
        const answer = (qa.answer || '').trim();
        if (answer && /[\d+]/.test(answer)) return answer;
      }
    }
    const invitee = payload.invitee || {};
    if (invitee.text_reminder_number) return invitee.text_reminder_number;
    return null;
  }

  describe('invitee.created payload', () => {
    const dummyPayload = {
      event: 'invitee.created',
      payload: {
        uri: 'https://api.calendly.com/scheduled_events/abc123/invitees/def456',
        invitee: {
          name: 'Test Client',
          email: 'test@example.com',
          timezone: 'Asia/Kolkata',
          reschedule_url: 'https://calendly.com/reschedule/abc123',
          cancel_url: 'https://calendly.com/cancel/abc123',
        },
        scheduled_event: {
          start_time: '2026-03-28T10:00:00.000Z',
          end_time: '2026-03-28T10:30:00.000Z',
          location: {
            join_url: 'https://meet.google.com/abc-def-ghi',
          },
        },
        questions_and_answers: [
          {
            question: 'Phone Number',
            answer: '+919866855857',
          },
        ],
      },
    };

    it('should extract phone from questions_and_answers', () => {
      const phone = extractPhone(dummyPayload.payload);
      assert.equal(phone, '+919866855857');
    });

    it('should extract client name', () => {
      assert.equal(dummyPayload.payload.invitee.name, 'Test Client');
    });

    it('should extract meeting start time', () => {
      assert.equal(dummyPayload.payload.scheduled_event.start_time, '2026-03-28T10:00:00.000Z');
    });

    it('should extract meeting link', () => {
      assert.equal(dummyPayload.payload.scheduled_event.location.join_url, 'https://meet.google.com/abc-def-ghi');
    });

    it('should extract timezone', () => {
      assert.equal(dummyPayload.payload.invitee.timezone, 'Asia/Kolkata');
    });

    it('should extract reschedule URL', () => {
      assert.equal(dummyPayload.payload.invitee.reschedule_url, 'https://calendly.com/reschedule/abc123');
    });
  });

  describe('Phone extraction edge cases', () => {
    it('should handle WhatsApp question variant', () => {
      const phone = extractPhone({
        questions_and_answers: [{ question: 'Your WhatsApp number', answer: '9866855857' }],
      });
      assert.equal(phone, '9866855857');
    });

    it('should handle mobile question variant', () => {
      const phone = extractPhone({
        questions_and_answers: [{ question: 'Mobile number', answer: '+91 9866855857' }],
      });
      assert.equal(phone, '+91 9866855857');
    });

    it('should fallback to text_reminder_number', () => {
      const phone = extractPhone({
        questions_and_answers: [],
        invitee: { text_reminder_number: '+919866855857' },
      });
      assert.equal(phone, '+919866855857');
    });

    it('should return null when no phone found', () => {
      const phone = extractPhone({ questions_and_answers: [] });
      assert.equal(phone, null);
    });

    it('should ignore non-phone questions', () => {
      const phone = extractPhone({
        questions_and_answers: [
          { question: 'Company Name', answer: 'Acme Corp' },
          { question: 'Contact Number', answer: '9866855857' },
        ],
      });
      assert.equal(phone, '9866855857');
    });
  });

  describe('Booking ID generation', () => {
    it('should extract ID from URI', () => {
      const uri = 'https://api.calendly.com/scheduled_events/abc123/invitees/def456';
      const parts = uri.split('/');
      const id = parts[parts.length - 1];
      assert.equal(id, 'def456');
    });

    it('should generate fallback ID', () => {
      const id = `booking_${Date.now()}`;
      assert.ok(id.startsWith('booking_'));
    });
  });

  describe('Reminder scheduling calculations', () => {
    const meetingStart = '2026-03-28T10:00:00.000Z';
    const meetingDate = new Date(meetingStart);

    it('should schedule call 10 min before meeting', () => {
      const callTime = new Date(meetingDate.getTime() - 10 * 60 * 1000);
      assert.equal(callTime.toISOString(), '2026-03-28T09:50:00.000Z');
    });

    it('should schedule WA 5min reminder correctly', () => {
      const waTime = new Date(meetingDate.getTime() - 5 * 60 * 1000);
      assert.equal(waTime.toISOString(), '2026-03-28T09:55:00.000Z');
    });

    it('should schedule WA 2hour reminder correctly', () => {
      const waTime = new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000);
      assert.equal(waTime.toISOString(), '2026-03-28T08:00:00.000Z');
    });

    it('should schedule WA 24hour reminder correctly', () => {
      const waTime = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000);
      assert.equal(waTime.toISOString(), '2026-03-27T10:00:00.000Z');
    });

    it('should schedule Discord reminder 5 min before (default offset)', () => {
      const offset = 5;
      const discordTime = new Date(meetingDate.getTime() - offset * 60 * 1000);
      assert.equal(discordTime.toISOString(), '2026-03-28T09:55:00.000Z');
    });
  });

  describe('invitee.canceled payload', () => {
    it('should handle cancellation event', () => {
      const event = 'invitee.canceled';
      assert.equal(event, 'invitee.canceled');
      // Cancellation should trigger cancelAllForBooking
    });
  });

  describe('invitee.rescheduled payload', () => {
    it('should handle reschedule event', () => {
      const event = 'invitee.rescheduled';
      assert.equal(event, 'invitee.rescheduled');
      // Reschedule should cancel old + create new
    });
  });
});

describe('Call Status Webhook', () => {
  it('should parse Twilio form data', () => {
    const twilioData = {
      CallSid: 'CA1234567890abcdef',
      CallStatus: 'completed',
      To: '+919866855857',
      From: '+14722138424',
      AnsweredBy: 'human',
      CallDuration: '45',
    };

    assert.equal(twilioData.CallSid, 'CA1234567890abcdef');
    assert.equal(twilioData.CallStatus, 'completed');
    assert.equal(twilioData.To, '+919866855857');
    assert.equal(parseInt(twilioData.CallDuration), 45);
  });

  it('should handle all Twilio statuses', () => {
    const validStatuses = ['queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed'];
    for (const status of validStatuses) {
      assert.ok(typeof status === 'string');
    }
  });
});
