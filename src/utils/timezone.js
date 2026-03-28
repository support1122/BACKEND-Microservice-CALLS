'use strict';

const { DateTime } = require('luxon');

const COUNTRY_CODE_TO_TZ = {
  '+1': 'America/New_York',
  '+91': 'Asia/Kolkata',
  '+44': 'Europe/London',
  '+61': 'Australia/Sydney',
  '+971': 'Asia/Dubai',
  '+65': 'Asia/Singapore',
  '+49': 'Europe/Berlin',
  '+33': 'Europe/Paris',
  '+81': 'Asia/Tokyo',
  '+86': 'Asia/Shanghai',
};

function detectTimezoneFromPhone(phone) {
  if (!phone) return 'Asia/Kolkata';

  const cleaned = String(phone).trim();

  for (const [code, tz] of Object.entries(COUNTRY_CODE_TO_TZ)) {
    if (cleaned.startsWith(code)) return tz;
  }

  return 'Asia/Kolkata';
}

function formatMeetingTime(isoString, timezone) {
  const dt = DateTime.fromISO(isoString, { zone: 'utc' }).setZone(timezone);
  const abbr = getTimezoneAbbr(timezone, dt);
  return dt.toFormat("LLL dd, yyyy 'at' hh:mm a") + ` ${abbr}`;
}

function getTimezoneAbbr(timezone, dt) {
  const ref = dt || DateTime.now().setZone(timezone);
  return ref.toFormat('ZZZZ');
}

function minutesBefore(isoString, minutes) {
  const dt = DateTime.fromISO(isoString, { zone: 'utc' });
  return dt.minus({ minutes }).toJSDate();
}

module.exports = {
  detectTimezoneFromPhone,
  formatMeetingTime,
  getTimezoneAbbr,
  minutesBefore,
};
