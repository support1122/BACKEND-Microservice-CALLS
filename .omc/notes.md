# Microservice-ARC — Important Notes

## Why This Exists
The main Express backend was getting overwhelmed running campaigns, workflows, CRM, payments AND time-critical reminders all on one server. This microservice offloads the latency-sensitive reminder operations.

## Shared Resources
- **MongoDB**: Same database, same collections. Models here are mirrors of the parent app's Schema_Models.
- **Calendly Webhook**: Same webhook endpoint. Both services process it — main server handles workflows/CRM, this handles calls/WA/BDA/Discord.
- **.env**: Reads from parent's .env file (../../../.env relative path).

## What This Service Handles (ONLY these)
1. **Twilio Calls** — Schedule and execute pre-meeting calls
2. **WhatsApp Reminders** — WATI template messages (5min, 2h, 24h before meeting)
3. **BDA Absent Detection** — Poll for absent BDAs and notify Discord
4. **Discord Meeting Reminders** — Team notifications before meetings

## What This Service Does NOT Handle
- Workflows (email/WA campaign sequences)
- CRM operations
- Payment processing
- Campaign scheduling
- Lead management
- Email sending (SendGrid)
- Page visit tracking
- GeoIP detection

## Critical Implementation Details
- **Precision timers**: Uses setTimeout with exact ms offset, NOT polling-first
- **Atomic DB transitions**: findOneAndUpdate with status condition prevents double-processing
- **Safety net**: 30s poll catches items missed due to restart
- **Timer preload**: On startup, ALL pending reminders are loaded and timers set
- **Graceful shutdown**: Drains in-flight operations before exit

## Test Phone Number
- +919866855857 — Use this for all test calls and WhatsApp messages

## Future Considerations
- Add Redis-based scheduling if DB polling becomes a bottleneck
- Add Prometheus metrics export for monitoring
- Consider WebSocket for real-time dashboard updates
- Rate limiting on debug endpoints in production
