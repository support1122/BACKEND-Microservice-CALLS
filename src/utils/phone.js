'use strict';

const PHONE_REGEX = /^\+?[1-9]\d{9,14}$/;

function normalizePhoneForReminders(phone) {
  if (!phone) return null;

  let cleaned = String(phone).replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('+')) return cleaned;

  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
    return `+${cleaned}`;
  }

  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  if (cleaned.length === 12 && cleaned.startsWith('91') && /^91[6-9]/.test(cleaned)) {
    return `+${cleaned}`;
  }

  if (cleaned.length === 10 && /^[2-9]/.test(cleaned)) {
    return `+1${cleaned}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  }

  return `+${cleaned}`;
}

function normalizePhoneForMatching(phone) {
  if (!phone) return null;

  let cleaned = String(phone).replace(/[\s\-().+]/g, '');

  if (cleaned.startsWith('91') && cleaned.length === 12) {
    return cleaned.slice(2);
  }

  if (cleaned.startsWith('1') && cleaned.length === 11) {
    return cleaned.slice(1);
  }

  return cleaned;
}

function isValidPhone(phone) {
  if (!phone) return false;
  const cleaned = String(phone).replace(/[\s\-().]/g, '');
  return PHONE_REGEX.test(cleaned);
}

module.exports = {
  normalizePhoneForReminders,
  normalizePhoneForMatching,
  isValidPhone,
};
