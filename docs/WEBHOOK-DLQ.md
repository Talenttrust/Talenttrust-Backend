# Webhook DLQ (Dead Letter Queue)

This document describes the webhook DLQ persistence implementation.

## Overview

Failed webhook deliveries are persisted to durable SQLite storage for later inspection and replay.

## Components

### Storage (`src/queue/webhook-dlq.ts`)

- SQLite-backed persistent storage
- Deduplication via SHA-256 hash key (webhookId + payload)
- Unique constraint prevents duplicate entries

### Retry Policy (`src/queue/webhook-retry-policy.ts`)

- Max 5 retry attempts
- Exponential backoff: 1s → 2s → 4s → 8s → 16s
- 10% jitter to prevent thundering herd
- Max delay cap: 30s

### Admin Endpoints (`src/routes/admin.routes.ts`)

| Method | Endpoint | Description |
|--------|----------|------------|
| GET | /api/v1/admin/webhook-dlq | List DLQ entries |
| GET | /api/v1/admin/webhook-dlq/:id | Get single entry |
| POST | /api/v1/admin/webhook-dlq/:id/replay | Replay webhook |

## Security

- All endpoints require admin JWT role
- `webhookSecret` is never returned in API responses
- Replay requires a reason (min 5 chars) for audit

## Environment

| Variable | Description | Default |
|----------|-------------|---------|
| WEBHOOK_DLQ_PATH | SQLite DB path | `./data/webhook-dlq.db` |