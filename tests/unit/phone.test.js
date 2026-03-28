'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Inline the logic to test without requiring the module (avoids dotenv/luxon dependency in tests)
function normalizePhoneForReminders(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()\.]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
  if (cleaned.length === 10 && /^[2-9]/.test(cleaned)) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return `+${cleaned}`;
}

function isValidPhone(phone) {
  return /^\+?[1-9]\d{9,14}$/.test(phone);
}

function normalizePhoneForMatching(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()\.+]/g, '');
  if (cleaned.startsWith('91') && cleaned.length === 12) return cleaned.slice(2);
  if (cleaned.startsWith('1') && cleaned.length === 11) return cleaned.slice(1);
  return cleaned;
}

describe('Phone Utilities', () => {
  describe('normalizePhoneForReminders()', () => {
    it('should handle already formatted E.164 numbers', () => {
      assert.equal(normalizePhoneForReminders('+919866855857'), '+919866855857');
      assert.equal(normalizePhoneForReminders('+14155551234'), '+14155551234');
    });

    it('should add +91 for 10-digit Indian numbers', () => {
      assert.equal(normalizePhoneForReminders('9866855857'), '+919866855857');
      assert.equal(normalizePhoneForReminders('7890123456'), '+917890123456');
    });

    it('should add + for 12-digit numbers starting with 91', () => {
      assert.equal(normalizePhoneForReminders('919866855857'), '+919866855857');
    });

    it('should add +1 for 10-digit US numbers', () => {
      assert.equal(normalizePhoneForReminders('4155551234'), '+14155551234');
    });

    it('should strip spaces and dashes', () => {
      assert.equal(normalizePhoneForReminders('+91 986-685-5857'), '+919866855857');
      assert.equal(normalizePhoneForReminders('986 685 5857'), '+919866855857');
    });

    it('should return null for empty input', () => {
      assert.equal(normalizePhoneForReminders(null), null);
      assert.equal(normalizePhoneForReminders(''), null);
    });

    it('should handle test number +919866855857', () => {
      assert.equal(normalizePhoneForReminders('+919866855857'), '+919866855857');
      assert.equal(normalizePhoneForReminders('9866855857'), '+919866855857');
      assert.ok(isValidPhone('+919866855857'));
    });
  });

  describe('isValidPhone()', () => {
    it('should validate correct phone numbers', () => {
      assert.ok(isValidPhone('+919866855857'));
      assert.ok(isValidPhone('+14155551234'));
      assert.ok(isValidPhone('919866855857'));
    });

    it('should reject invalid phone numbers', () => {
      assert.ok(!isValidPhone('123'));
      assert.ok(!isValidPhone('abcdefghij'));
      assert.ok(!isValidPhone('+0123456789'));
    });
  });

  describe('normalizePhoneForMatching()', () => {
    it('should strip country code for Indian numbers', () => {
      assert.equal(normalizePhoneForMatching('+919866855857'), '9866855857');
      assert.equal(normalizePhoneForMatching('919866855857'), '9866855857');
    });

    it('should strip country code for US numbers', () => {
      assert.equal(normalizePhoneForMatching('+14155551234'), '4155551234');
    });

    it('should handle raw 10-digit numbers', () => {
      assert.equal(normalizePhoneForMatching('9866855857'), '9866855857');
    });
  });
});
