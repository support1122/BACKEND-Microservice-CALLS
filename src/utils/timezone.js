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

  // Sort by longest code first so +971 matches before +9, +91 before +1, etc.
  const sortedCodes = Object.entries(COUNTRY_CODE_TO_TZ)
    .sort(([a], [b]) => b.length - a.length);
  for (const [code, tz] of sortedCodes) {
    if (cleaned.startsWith(code)) return tz;
  }

  return 'Asia/Kolkata';
}

function formatMeetingTime(isoString, timezone) {
  let dt;

  // Handle Date objects from MongoDB (DateTime.fromISO only accepts strings)
  if (isoString instanceof Date) {
    dt = DateTime.fromJSDate(isoString, { zone: 'utc' });
  } else if (typeof isoString === 'string' && isoString.length > 0) {
    dt = DateTime.fromISO(isoString, { zone: 'utc' });
  } else {
    return 'Unknown';
  }

  if (!dt || !dt.isValid) {
    return 'Unknown';
  }

  dt = dt.setZone(timezone || 'Asia/Kolkata');
  const abbr = getTimezoneAbbr(timezone, dt);
  return dt.toFormat("LLL dd, yyyy 'at' hh:mm a") + ` ${abbr}`;
}

// Luxon ZZZZ returns "GMT+5:30" for Asia/Kolkata etc — override with common abbreviations
const TZ_ABBR_MAP = {
  'Asia/Kolkata': 'IST',
  'Asia/Dubai': 'GST',
  'Asia/Singapore': 'SGT',
  'Asia/Tokyo': 'JST',
  'Asia/Shanghai': 'CST',
  'Australia/Sydney': 'AEST',
};

function getTimezoneAbbr(timezone, dt) {
  if (timezone && TZ_ABBR_MAP[timezone]) return TZ_ABBR_MAP[timezone];
  const ref = dt || DateTime.now().setZone(timezone);
  const abbr = ref.toFormat('ZZZZ');
  // If Luxon returns a proper abbreviation (not GMT+X), use it
  if (abbr && !abbr.startsWith('GMT') && !abbr.startsWith('UTC')) return abbr;
  // For US/EU zones Luxon gives proper abbreviations like EST, PDT, CET
  return abbr;
}

function minutesBefore(isoString, minutes) {
  let dt;
  if (isoString instanceof Date) {
    dt = DateTime.fromJSDate(isoString, { zone: 'utc' });
  } else {
    dt = DateTime.fromISO(isoString, { zone: 'utc' });
  }
  if (!dt || !dt.isValid) return null;
  return dt.minus({ minutes }).toJSDate();
}

module.exports = {
  detectTimezoneFromPhone,
  formatMeetingTime,
  getTimezoneAbbr,
  minutesBefore,
};
