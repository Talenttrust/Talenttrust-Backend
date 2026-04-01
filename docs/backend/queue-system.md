# Queue-Based Background Jobs System

## Overview

The TalentTrust backend implements a robust, durable queue-based background job system using BullMQ and Redis. This system offloads heavy asynchronous tasks from the main request-response cycle, improving API responsiveness and reliability.

## Architecture

### Components

1. **QueueManager**: Central singleton managing all queues and workers
2. **Job Processors**: Specialized handlers for each job type
3. **Queue Configuration**: Environment-based Redis connection settings
4. **Job Types**: Type-safe job definitions with validation

### Job Types

The system supports four primary job types:

- **EMAIL_NOTIFICATION**: Asynchronous email sending
- **CONTRACT_PROCESSING**: Heavy contract operations (create, update, finalize)
- **REPUTATION_UPDATE**: User reputation score calculations
- **BLOCKCHAIN_SYNC**: Blockchain data synchronization

## Usage

### Enqueueing Jobs

Use the REST API to enqueue background jobs:

```bash
POST /api/v1/jobs
Content-Type: application/json

{
  "type": "email-notification",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome to TalentTrust",
    "body": "Thank you for joining!"
  },
  "options": {
    "priority": 1,
    "delay": 0
  }
}
```

Response:
```json
{
  "jobId": "1234567890",
  "type": "email-notification",
  "status": "queued"
}
```

### Checking Job Status

```bash
GET /api/v1/jobs/{type}/{jobId}
```

Response:
```json
{
  "id": "1234567890",
  "name": "email-notification",
  "state": "completed",
  "data": { ... },
  "returnvalue": { ... }
}
```

### Programmatic Usage

```typescript
import { QueueManager, JobType } from './queue';

const queueManager = QueueManager.getInstance();

// Initialize queues
await queueManager.initializeQueue(JobType.EMAIL_NOTIFICATION);

// Add a job
const jobId = await queueManager.addJob(
  JobType.EMAIL_NOTIFICATION,
  {
    to: 'user@example.com',
    subject: 'Hello',
    body: 'World',
  }
);

// Check status
const status = await queueManager.getJobStatus(JobType.EMAIL_NOTIFICATION, jobId);
```

## Configuration

### Environment Variables

Configure Redis connection using environment variables:

```bash
REDIS_HOST=localhost      # Default: localhost
REDIS_PORT=6379          # Default: 6379
REDIS_PASSWORD=secret    # Optional
```

### Job Options

Default job configuration (in `src/queue/config.ts`):

- **Attempts**: 3 retries on failure
- **Backoff**: Exponential backoff starting at 2 seconds
- **Cleanup**: Keep last 100 completed jobs, 1000 failed jobs

## Job Processors

### Email Notification

Handles email sending with validation:

- Validates email format
- Requires subject and body
- Returns email ID for tracking

### Contract Processing

Processes contract operations:

- **create**: Initialize new contract on blockchain
- **update**: Update contract metadata
- **finalize**: Complete contract and trigger payment

### Reputation Update

Calculates and updates user reputation:

- Validates rating range (1-5)
- Aggregates historical ratings
- Updates user profile

### Blockchain Sync

Synchronizes blockchain data:

- Supports Stellar and Soroban networks
- Processes blocks in batches
- Tracks sync progress

## Security Considerations

### Input Validation

All processors implement strict input validation:

- Email format validation
- Contract ID format checks
- Rating range validation
- Network type whitelisting

### Error Handling

- Jobs retry up to 3 times with exponential backoff
- Failed jobs are logged with detailed error messages
- Graceful degradation on processor failures

### Redis Security

- Support for password authentication
- Connection pooling with limits
- Secure environment variable configuration

### Threat Scenarios

1. **Malicious Job Payloads**: Mitigated by strict validation in processors
2. **Queue Flooding**: Rate limiting should be implemented at API level
3. **Redis Unauthorized Access**: Use strong passwords and network isolation
4. **Job Data Exposure**: Sensitive data should be encrypted before enqueueing

## Performance

### Concurrency

- Each worker processes up to 5 jobs concurrently
- Configurable per job type based on resource requirements

### Scalability

- Horizontal scaling: Multiple worker instances can process the same queue
- Redis cluster support for high availability
- Job prioritization for critical operations

### Monitoring

Event listeners track:

- Job completion and failures
- Queue waiting times
- Active job counts

## Testing

Run the test suite:

```bash
npm test
```

Test coverage includes:

- Unit tests for all processors
- Integration tests for API endpoints
- Configuration validation tests
- Error handling scenarios
- Edge cases and failure paths

Target: 95%+ test coverage

## Deployment

### Prerequisites

- Redis 6.0+ running and accessible
- Node.js 18+
- Environment variables configured

### Production Checklist

1. Configure Redis with authentication
2. Set appropriate environment variables
3. Monitor queue metrics (length, processing time)
4. Set up alerts for failed jobs
5. Implement job result persistence if needed
6. Configure log aggregation

### Docker Compose Example

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --requirepass ${REDIS_PASSWORD}
  
  backend:
    build: .
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    depends_on:
      - redis
```

## Troubleshooting

### Queue Not Processing Jobs

1. Check Redis connection: `redis-cli ping`
2. Verify environment variables are set
3. Check worker logs for errors

### Jobs Failing Repeatedly

1. Review job payload validation
2. Check processor error logs
3. Verify external service availability (email, blockchain)

### High Memory Usage

1. Reduce `removeOnComplete` and `removeOnFail` values
2. Implement job result cleanup
3. Monitor Redis memory usage

## Future Enhancements

- Job scheduling (cron-like patterns)
- Job dependencies and workflows
- Dead letter queue for permanently failed jobs
- Real-time job progress updates via WebSocket
- Admin dashboard for queue monitoring
- Rate limiting per job type
