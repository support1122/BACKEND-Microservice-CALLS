# Microservice-ARC (Automated Reminder Controller)

Precision reminder microservice for **Calls**, **WhatsApp**, **BDA Attendance**, and **Discord** notifications. Built with **Fastify** for maximum throughput, offloading time-critical reminder operations from the main Express server.

## Architecture

```
Calendly Webhook (shared)
       │
       ├── Main Server (Express) → Workflows, Campaigns, CRM, Payments, etc.
       │
       └── Microservice-ARC (Fastify) → Calls, WhatsApp, BDA, Discord reminders
                │
                ├── UnifiedScheduler (precision setTimeout timers)
                │   ├── CallHandler → Twilio
                │   ├── WhatsAppHandler → WATI
                │   ├── DiscordReminderHandler → Discord Webhooks
                │   └── Safety-net poll (30s) for missed items
                │
                └── BdaAbsentDetector (60s poll)
                    └── Discord notifications
```

## Key Design Decisions

1. **Fastify over Express** — 2-3x faster JSON serialization, built-in schema validation, lower overhead
2. **setTimeout precision** — Each reminder gets an exact millisecond-offset timer instead of polling-first. Zero-delay guarantee.
3. **DB-based scheduling** — No Redis dependency. MongoDB stores all reminder state with atomic status transitions (`pending → processing → completed/failed`)
4. **Safety-net polling** — 30-second backup sweep catches any timers that were missed (process restart, etc.)
5. **Circuit breakers** — On Twilio, WATI, and Discord APIs to prevent cascade failures
6. **Same Calendly webhook** — This service processes only call/WA/BDA/Discord reminder parts. Forward the same webhook to both services.

## Setup

```bash
cd Microservice
npm install
```

### Environment

Uses the **same .env** as the parent backend. Key variables:

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | Shared MongoDB connection |
| `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM` | Phone calls |
| `WATI_API_BASE_URL/API_TOKEN/TENANT_ID` | WhatsApp messages |
| `DISCORD_*_WEBHOOK_URL` | Discord notifications |
| `PORT` | Service port (default: 4000) |

## Running

```bash
# Production
npm start

# Development (auto-reload)
npm run dev

# Tests
npm test
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Service info |
| GET | `/health` | Health check + active timer count |
| POST | `/calendly-webhook` | Calendly event handler |
| POST | `/call-status` | Twilio call status callback |
| POST | `/twilio-ivr` | Twilio IVR voice response |
| GET | `/api/scheduler/stats` | Scheduler statistics |
| GET | `/api/scheduler/upcoming` | Next 10 upcoming reminders per type |
| POST | `/api/debug/test-call` | Manual test call |
| POST | `/api/debug/test-whatsapp` | Manual test WhatsApp |
| POST | `/api/debug/test-discord` | Manual test Discord reminder |
| DELETE | `/api/debug/cancel/:bookingId` | Cancel all reminders for booking |

## Testing with Dummy Data

```bash
# Test call to +919866855857
curl -X POST http://localhost:4000/api/debug/test-call \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+919866855857",
    "meetingStartISO": "2026-03-28T10:00:00Z",
    "inviteeName": "Test Client",
    "bookingId": "test_booking_001"
  }'

# Test WhatsApp reminder
curl -X POST http://localhost:4000/api/debug/test-whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+919866855857",
    "meetingStartISO": "2026-03-28T10:00:00Z",
    "clientName": "Test Client",
    "reminderType": "5min"
  }'

# Test Discord reminder
curl -X POST http://localhost:4000/api/debug/test-discord \
  -H "Content-Type: application/json" \
  -d '{
    "meetingStartISO": "2026-03-28T10:00:00Z",
    "clientName": "Test Client",
    "clientEmail": "test@example.com"
  }'
```

## Deployment Notes

1. **Calendly webhook**: Configure the same webhook URL to forward to BOTH the main server and this microservice, OR have the main server proxy the relevant events.
2. **Port separation**: Main server on 3000, this service on 4000 (configurable via PORT env).
3. **Process manager**: Use PM2 or similar to run alongside the main server.
4. **Monitoring**: Hit `/health` for liveness checks, `/api/scheduler/stats` for metrics.

## Reminder Timing

| Reminder | Offset |
|----------|--------|
| Twilio Call | 10 min before meeting |
| WhatsApp (5min) | 5 min before meeting |
| WhatsApp (2hour) | 2 hours before meeting |
| WhatsApp (24hour) | 24 hours before meeting |
| Discord | 5 min before meeting (configurable) |
| BDA Absent Check | 60s after meeting start |
