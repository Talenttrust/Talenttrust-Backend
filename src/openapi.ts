import { createHash } from 'crypto';
import { config, explorerUrl } from './config';
import { ALLOWED_FIELDS } from './utils/project';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }, headers?: object) => ({
  200: { description, ...(headers ? { headers } : {}), content: json(schema) },
});
const errorResponse = (description: string, schema: object = { $ref: '#/components/schemas/ErrorResponse' }) => ({
  description,
  content: json(schema),
});
const created = (description: string, schema: object = { type: 'object' }) => ({
  201: { description, content: json(schema) },
});
const receiptQueryParam = {
  name: 'receipt',
  in: 'query',
  required: false,
  schema: { type: 'boolean' },
  description: 'When true, includes detached JWS Receipt header for the contract state',
};
const receiptHeaders = {
  Receipt: {
    schema: { type: 'string' },
    description: 'Detached compact JWS receipt of post-mutation contract state',
  },
};

const validationErrorResponse = {
  400: {
    description: 'Validation failed',
    content: json({ $ref: '#/components/schemas/ValidationError' }),
  },
};

const errorResponses = {
  400: {
    description: 'Validation failed',
    content: json({ $ref: '#/components/schemas/ValidationError' }),
  },
  403: {
    description: 'Forbidden',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  404: {
    description: 'Not found',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  409: {
    description: 'Conflict',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  500: {
    description: 'Internal error',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
  description: 'Contract ID (positive integer)',
};
const indexParam = {
  name: 'index',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^(?:[0-9]|1[0-9])$' },
  description: 'Milestone index (0-19)',
};
const addressParam = {
  name: 'address',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/StellarAccount' },
  description: 'Stellar G… account address',
};
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const reviewRef = { $ref: '#/components/schemas/Review' };
const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
const reputationRef = { $ref: '#/components/schemas/Reputation' };

/**
 * `?fields=` query parameter shared by GET /contracts and GET /contracts/:id.
 * Clients may request a subset of EscrowContract fields to reduce payload
 * size.  `id` is always returned.  Use dot notation for milestone sub-fields
 * (e.g. `milestones.amount`).  Unknown fields yield a 400 error.
 */
const fieldsParam = {
  name: 'fields',
  in: 'query',
  required: false,
  description:
    'Comma-separated list of fields to include in the response. ' +
    '`id` is always returned. Use `milestones.amount` style notation for ' +
    'nested milestone fields. Unknown fields return 400. ' +
    `Allowed values: ${ALLOWED_FIELDS.join(', ')}.`,
  schema: {
    type: 'string',
    example: 'title,status,totalAmount',
  },
};

const fieldsError = {
  400: {
    description: 'Invalid `?fields=` value. The response body lists valid field names.',
    content: json(errorRef),
  },
};

const amountSchema = {
  oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]{0,37}$' }],
  description: 'Amount in token base units. Must be a positive integer.',
};
const milestonesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    oneOf: [
      amountSchema,
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          amount: amountSchema,
        },
        required: ['amount'],
      },
    ],
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'TalentTrust API',
    version: config.version,
    description:
      'Milestone-based escrow API for freelancers and clients. State mirrors the TalentTrust ' +
      `Soroban escrow contract on Stellar ${config.network} (${config.contractId}). ` +
      `Explorer: ${explorerUrl()}. Data is held in memory and resets on redeploy.\n\n` +
      '**Response compression**: The API compresses JSON responses ≥ 1 KB with gzip or Brotli ' +
      'when the client sends an `Accept-Encoding` header. A `Vary: Accept-Encoding` header is ' +
      'included on compressed responses.\n\n' +
      '**Sparse fieldsets**: GET /contracts and GET /contracts/:id accept a `?fields=` query ' +
      'parameter so clients can download only the fields they need.\n\n' +
      '**Authentication**: mutating routes accept a bearer token obtained via the auth endpoints. ' +
      'Call `GET /api/v1/auth/challenge?address=G…`, sign the returned challenge string with your ' +
      'Stellar ed25519 private key, then `POST /api/v1/auth/token` to receive a short-lived JWT. ' +
      'Tokens are required when the server runs with `AUTH_SECRET` set (or `AUTH_REQUIRED=true`).',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'System' },
    { name: 'Auth', description: 'Wallet-signature authentication (SEP-10 style)' },
    { name: 'Contracts' },
    { name: 'Reputation' },
    { name: 'Transaction' },
    { name: 'Receipts' },
    { name: 'Cron' },
    { name: 'Transactions', description: 'Relay of wallet-signed escrow transactions to Soroban RPC' },
    { name: 'Webhooks', description: 'Signed, retried event deliveries (WEBHOOK_ADMIN_TOKEN)' },
    { name: 'Events', description: 'Indexed on-chain escrow contract events' },
    { name: 'Parties', description: 'Per-address activity statements' },
    { name: 'Templates', description: 'Reusable milestone plans for creating contracts' },
    { name: 'Audit', description: 'Tamper-evident, hash-chained log of escrow state transitions' },
    { name: 'Disputes', description: 'Admin dispute queue. Requires the ADMIN_READ_TOKEN bearer token.' },
  ],
  paths: {
    '/api/v1/tx/submit': {
      post: {
        tags: ['Transactions'],
        summary: 'Validate and relay a signed Soroban escrow transaction to RPC',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['xdr'],
            properties: {
              xdr: {
                type: 'string',
                description: 'Base64-encoded signed TransactionEnvelope XDR targeting the configured escrow contract',
              },
            },
          }),
        },
        responses: {
          200: {
            description: 'Transaction was already known (DUPLICATE); returns current status',
            content: json({ $ref: '#/components/schemas/TxStatusResponse' }),
          },
          202: {
            description: 'Transaction accepted and pending inclusion in a ledger',
            content: json({
              type: 'object',
              required: ['hash', 'status'],
              properties: {
                hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                status: { type: 'string', enum: ['PENDING'] },
              },
            }),
          },
          400: {
            description: 'Invalid transaction XDR or failed escrow contract validation rules',
            content: json({ $ref: '#/components/schemas/ErrorResponse' }),
          },
          422: {
            description: 'Transaction rejected by Soroban RPC (submission_failed)',
            content: json({
              type: 'object',
              required: ['error', 'message', 'code'],
              properties: {
                error: { type: 'string', enum: ['submission_failed'] },
                message: { type: 'string' },
                code: { type: 'string', description: 'Decoded TransactionResultCode (e.g. txBadSeq, txInsufficientFee)' },
                hash: { type: 'string' },
              },
            }),
          },
          503: {
            description: 'Soroban RPC returned TRY_AGAIN_LATER',
            headers: {
              'Retry-After': {
                description: 'Seconds to wait before retrying submission',
                schema: { type: 'integer' },
              },
            },
            content: json({ $ref: '#/components/schemas/ErrorResponse' }),
          },
        },
      },
    },
    '/api/v1/tx': {
      get: {
        tags: ['Transactions'],
        summary: 'List recent relayed escrow transactions from the bounded LRU cache',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum number of recent transactions to return (default 20)',
            schema: { type: 'integer', minimum: 1, maximum: config.txCacheMax, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Recent relayed transactions (most recent first)',
            content: json({
              type: 'object',
              required: ['data'],
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/RelayedTransaction' } },
              },
            }),
          },
          400: {
            description: 'Invalid limit parameter',
            content: json({ $ref: '#/components/schemas/ErrorResponse' }),
          },
        },
      },
    },
    '/api/v1/tx/{hash}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get transaction status, decoded returnValue, and contract error details',
        parameters: [
          {
            name: 'hash',
            in: 'path',
            required: true,
            description: '64-character hex transaction hash',
            schema: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
          },
          {
            name: 'wait',
            in: 'query',
            required: false,
            description: 'If true, long-polls up to 20s (every 1s) until transaction leaves PENDING/NOT_FOUND',
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: {
          200: {
            description: 'Transaction status and decoded result',
            content: json({ $ref: '#/components/schemas/TxStatusResponse' }),
          },
          400: {
            description: 'Invalid transaction hash format',
            content: json({ $ref: '#/components/schemas/ErrorResponse' }),
          },
          503: {
            description: 'Too many concurrent long-poll requests',
            content: json({ $ref: '#/components/schemas/ErrorResponse' }),
          },
        },
      },
    },
    '/api/v1/webhook-subscriptions': {
      post: {
        tags: ['Webhooks'], summary: 'Create a signed webhook subscription',
        security: [{ webhookAdmin: [] }],
        requestBody: { required: true, content: json({ type: 'object', required: ['url', 'events'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } } } }) },
        responses: { 201: { description: 'Created; the secret is returned only once', content: json({ $ref: '#/components/schemas/WebhookSubscription' }) }, 400: { description: 'Invalid URL or event filter' }, 401: { description: 'Missing or invalid admin token' }, 404: { description: 'Webhooks are not configured' } },
      },
      get: { tags: ['Webhooks'], summary: 'List webhook subscriptions', security: [{ webhookAdmin: [] }], responses: { 200: { description: 'Subscriptions' }, 401: { description: 'Missing or invalid admin token' }, 404: { description: 'Webhooks are not configured' } } },
    },
    '/api/v1/webhook-subscriptions/{id}': {
      get: { tags: ['Webhooks'], summary: 'Get a webhook subscription', security: [{ webhookAdmin: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Subscription without secret' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found or disabled' } } },
      patch: { tags: ['Webhooks'], summary: 'Update a webhook subscription', security: [{ webhookAdmin: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: json({ type: 'object' }) }, responses: { 200: { description: 'Updated subscription' }, 400: { description: 'Invalid update' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } } },
      delete: { tags: ['Webhooks'], summary: 'Delete a webhook subscription', security: [{ webhookAdmin: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } } },
    },
    '/api/v1/webhook-subscriptions/{id}/rotate-secret': {
      post: { tags: ['Webhooks'], summary: 'Rotate a webhook secret', security: [{ webhookAdmin: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'New secret; returned only once' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } } },
    },
    '/api/v1/webhook-subscriptions/{id}/deliveries': {
      get: { tags: ['Webhooks'], summary: 'List bounded webhook delivery history', security: [{ webhookAdmin: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Delivery history' }, 401: { description: 'Unauthorized' }, 404: { description: 'Not found' } } },
    },
    '/api/v1/templates': {
      post: {
        tags: ['Templates'],
        summary: 'Create a milestone template (fixed amounts or percent of a budget)',
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/TemplateInput' }) },
        responses: { 201: { description: 'Created', content: json({ $ref: '#/components/schemas/Template' }) }, 400: errorResponse('Invalid template') },
      },
      get: {
        tags: ['Templates'],
        summary: 'List templates of an owner',
        parameters: [{ name: 'owner', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { ...ok('Templates', { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Template' } } } }), 400: errorResponse('owner is required') },
      },
    },
    '/api/v1/templates/{id}': {
      get: {
        tags: ['Templates'],
        summary: 'Get a template',
        parameters: [idParam],
        responses: { ...ok('Template', { $ref: '#/components/schemas/Template' }), 404: errorResponse('Template not found') },
      },
      put: {
        tags: ['Templates'],
        summary: 'Update a template (owner only; bumps version)',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/TemplateInput' }) },
        responses: {
          ...ok('Updated template', { $ref: '#/components/schemas/Template' }),
          400: errorResponse('Invalid template'),
          403: errorResponse('Not the owner'),
          404: errorResponse('Template not found'),
        },
      },
      delete: {
        tags: ['Templates'],
        summary: 'Delete a template (owner only; existing contracts are unaffected)',
        parameters: [idParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['owner'], properties: { owner: { type: 'string' } } }) },
        responses: {
          ...ok('Deleted', { type: 'object', properties: { success: { type: 'boolean' } } }),
          403: errorResponse('Not the owner'),
          404: errorResponse('Template not found'),
        },
      },
    },
    '/api/v1/contracts/{id}/history': {
      get: {
        tags: ['Audit'],
        summary: 'Get the audit history (successful state transitions) of a contract',
        parameters: [
          idParam,
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 }, description: 'Maximum number of entries to return' },
          { name: 'cursor', in: 'query', schema: { type: 'integer' }, description: 'Sequence number to start after (from nextCursor)' },
        ],
        responses: {
          ...ok('Audit history', {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } },
              nextCursor: { type: 'integer', description: 'Absent on the last page' },
            },
          }),
          400: errorResponse('Invalid id, limit or cursor'),
          404: errorResponse('Contract not found'),
        },
      },
    },
    '/api/v1/audit/verify': {
      get: {
        tags: ['Audit'],
        summary: 'Verify the integrity of the hash-chained audit log',
        responses: ok('Verification result', {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            entries: { type: 'integer' },
            brokenAt: { type: 'integer', description: 'seq of the first entry whose hash does not verify' },
          },
        }),
      },
    },
    '/api/v1/disputes': {
      get: {
        tags: ['Disputes'],
        summary: 'List the admin dispute queue',
        security: [{ adminToken: [] }],
        description:
          'Returns paginated dispute views plus queue-wide summary totals. The summary always ' +
          'covers ALL disputes in the store (open = contracts currently Disputed, overdue = open disputes ' +
          'past their SLA deadline, totalHeld = escrow held across open disputes), regardless of the filters. ' +
          'Dispute reasons are only exposed here and on /api/v1/disputes/{contractId}.',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'resolved', 'all'], default: 'all' } },
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string', enum: ['oldest', 'newest', 'value'], default: 'oldest' },
            description: 'oldest/newest: by openedAt; value: by held amount descending (ties broken by contractId)',
          },
          { name: 'overdue', in: 'query', schema: { type: 'boolean' }, description: 'Only open disputes past their SLA deadline' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'page.nextCursor of a previous request with the same sort' },
        ],
        responses: {
          ...ok('Dispute queue page', { $ref: '#/components/schemas/DisputeQueue' }),
          400: errorResponse('Invalid status, sort, overdue, limit, or cursor'),
          401: errorResponse('Missing or invalid admin bearer token'),
          404: errorResponse('ADMIN_READ_TOKEN is not configured (admin_not_configured)'),
        },
      },
    },
    '/api/v1/disputes/{contractId}': {
      get: {
        tags: ['Disputes'],
        summary: 'Get the dispute view for a contract',
        security: [{ adminToken: [] }],
        parameters: [{ name: 'contractId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          ...ok('Dispute view', { $ref: '#/components/schemas/DisputeView' }),
          400: errorResponse('contractId must be a positive integer'),
          401: errorResponse('Missing or invalid admin bearer token'),
          404: errorResponse('Contract has never had a dispute (dispute_not_found), or ADMIN_READ_TOKEN is not configured'),
        },
      },
    },
    '/api/v1/errors': {
      get: {
        tags: ['System'],
        summary: 'Error catalog: every error code with its HTTP status and title',
        responses: ok('Catalog keyed by error code', { type: 'object', additionalProperties: { type: 'object' } }),
      },
    },
    '/errors/{code}': {
      get: {
        tags: ['System'],
        summary: 'Describe one error code (problem `type` URI); HTML or JSON by Accept',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          ...ok('Error description'),
          404: errorResponse('Unknown error code (error_code_not_found)'),
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics endpoint',
        description:
          'Returns Prometheus exposition format text (HTTP RED metrics by route pattern, escrow gauges, ' +
          '`escrow_mutations_total{action,result}`, process metrics). Requires `Authorization: Bearer <METRICS_TOKEN>`. ' +
          'Returns 404 when METRICS_TOKEN is unset (endpoint disabled).',
        security: [{ metricsToken: [] }],
        responses: {
          200: { description: 'Prometheus exposition format', content: { 'text/plain': { schema: { type: 'string' } } } },
          401: errorResponse('Invalid or missing metrics token'),
          404: errorResponse('Metrics endpoint disabled (METRICS_TOKEN not set)'),
        },
      },
    },
    '/api/cron/expire-contracts': {
      get: {
        tags: ['Cron'],
        summary: 'Expire due unfunded contracts',
        description:
          'Daily sweep (Vercel cron) that moves still-unfunded `Created` contracts past their funding deadline ' +
          'to `Expired`, refunding any partial funding. Also accepts POST. Requires `Authorization: Bearer ' +
          '<CRON_SECRET>`; returns 404 when `CRON_SECRET` is not configured.',
        parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } }],
        responses: {
          ...ok('Sweep result', {
            type: 'object',
            required: ['expired', 'checkedAt'],
            properties: {
              expired: { type: 'array', items: { type: 'integer' } },
              checkedAt: { type: 'string', format: 'date-time' },
            },
          }),
          401: errorResponse('Invalid or missing bearer secret (cron_unauthorized)'),
          404: errorResponse('Cron secret is not configured'),
        },
      },
    },
    '/api/v1/contracts/{id}/extend-deadline': {
      post: {
        tags: ['Contracts'],
        summary: 'Extend a contract funding deadline (client only)',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client', 'fundingDeadline'],
            properties: {
              client: { type: 'string' },
              fundingDeadline: { type: 'string', format: 'date-time', description: 'Later than the current deadline, at most 90 days from now' },
            },
          }),
        },
        responses: {
          ...ok('Deadline extended', contractRef),
          400: errorResponse('Invalid deadline (invalid_deadline)'),
          403: errorResponse('Caller is not the client'),
          409: errorResponse('Contract has expired (contract_expired)'),
        },
      },
    },
    '/api/v1/auth/whoami': {
      get: {
        tags: ['Auth'],
        summary: 'Show the scoped API key in use (id and scopes)',
        security: [{ apiKey: [] }],
        responses: {
          ...ok('Key id and scopes', {
            type: 'object',
            required: ['keyId', 'scopes'],
            properties: { keyId: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } },
          }),
          401: errorResponse('Missing or invalid API key'),
        },
      },
    },
    '/api/v1/auth/challenge': {
      get: {
        tags: ['Auth'],
        summary: 'Request a sign challenge for a Stellar address',
        description:
          'Returns a short-lived HMAC-signed challenge string. ' +
          'Sign it with the ed25519 private key corresponding to `address` and pass it to `POST /api/v1/auth/token`.',
        parameters: [
          {
            name: 'address',
            in: 'query',
            required: true,
            description: 'Stellar G… ed25519 public key.',
            schema: { $ref: '#/components/schemas/StellarAccount' },
          },
        ],
        responses: {
          ...ok('Challenge issued.', { $ref: '#/components/schemas/ChallengeResponse' }),
          400: errorResponse('Invalid Stellar address (invalid_address).'),
        },
      },
    },
    '/api/v1/auth/token': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange a signed challenge for a bearer token',
        description:
          'Verifies the HMAC, challenge expiry, address match, and ed25519 signature. ' +
          'Returns an HS256 JWT (≤ 1 h) to use as `Authorization: Bearer <token>` on protected routes.',
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/TokenRequest' }) },
        responses: {
          ...ok('Token issued.', { $ref: '#/components/schemas/TokenResponse' }),
          401: errorResponse('invalid_challenge / challenge_expired / challenge_replayed / invalid_signature.'),
        },
      },
    },
    '/': {
      get: {
        tags: ['System'],
        summary: 'Service index',
        description: 'Service name, documentation links and the list of available endpoints.',
        responses: ok('Service index', { $ref: '#/components/schemas/ServiceInfo' }),
      },
    },
    '/docs': {
      get: {
        tags: ['System'],
        summary: 'Swagger UI for this spec',
        responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
    },
    '/openapi.json': {
      get: { tags: ['System'], summary: 'This OpenAPI document', responses: ok('OpenAPI 3.0.3 document', { type: 'object' }) },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        responses: {
          ...ok('Service is healthy', { $ref: '#/components/schemas/Health' }),
          503: {
            description: 'Draining during graceful shutdown (`Connection: close`)',
            'x-plain-json': true,
            content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['draining'] } } }),
          },
        },
      },
    },
    '/health/live': {
      get: {
        tags: ['System'],
        summary: 'Liveness probe',
        description: 'Always 200 while the process is up; touches no dependency.',
        responses: ok('Process is up', { $ref: '#/components/schemas/Liveness' }),
      },
    },
    '/health/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness probe',
        description:
          'Checks the Soroban RPC health, the network passphrase, the escrow contract ledger ' +
          'entry and the store in parallel. Results are cached for HEALTH_CACHE_MS with ' +
          'single-flight. 200 when every check passes (or only warns), 503 when a critical ' +
          'check fails. Failure details never include the RPC URL.',
        responses: {
          200: { description: 'Ready (or degraded)', content: json({ $ref: '#/components/schemas/Readiness' }) },
          503: {
            description: 'Unready',
            'x-plain-json': true,
            content: json({ $ref: '#/components/schemas/Readiness' }),
          },
        },
      },
    },
    '/.well-known/talenttrust-receipts.json': {
      get: {
        tags: ['Receipts'],
        summary: 'Published ed25519 public keys for offline JWS receipt verification',
        responses: ok('Published keys', { $ref: '#/components/schemas/PublishedKeys' }),
      },
    },
    '/api/v1/chain': {
      get: {
        tags: ['System'],
        summary: 'On-chain escrow contract deployment info with live contract status',
        description:
          'Static deployment info, the pause guard state, and `onChain`, a cached snapshot read from the Soroban RPC ' +
          '(contract version, paused flag, escrow count, admin, latest ledger). The endpoint always returns 200; when ' +
          'the RPC is unreachable, `onChain.reachable` is false and `onChain.error` explains why. If a previous snapshot ' +
          'exists it is served with `onChain.stale` true. Results are cached for CHAIN_STATUS_TTL_MS (15s); ' +
          '`refresh=true` bypasses the cache at most once per CHAIN_REFRESH_MIN_INTERVAL_MS (5s).',
        parameters: [
          {
            name: 'refresh',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true'] },
            description: 'Bypass the cache and re-read the contract (rate-limited).',
          },
        ],
        responses: ok('Deployment and live on-chain status', {
          type: 'object',
          properties: {
            network: { type: 'string' },
            rpcUrl: { type: 'string' },
            contractId: { type: 'string' },
            explorer: { type: 'string' },
            paused: { type: 'boolean' },
            pauseSource: { type: 'string', enum: ['chain', 'env', 'none'] },
            onChain: { $ref: '#/components/schemas/OnChainStatus' },
          },
        }),
      },
    },
    '/api/v1/chain/contracts/{chainId}': {
      get: {
        tags: ['Contracts'],
        summary: 'Read an escrow contract directly from Soroban (cached, 60 req/min per client)',
        parameters: [{ name: 'chainId', in: 'path', required: true, schema: { type: 'string', pattern: '^[1-9][0-9]*$' } }],
        responses: {
          ...ok('On-chain escrow contract', { $ref: '#/components/schemas/ChainEscrow' }),
          400: errorResponse('Invalid chain id (invalid_chain_id)'),
          404: errorResponse('Contract not found on chain'),
          429: errorResponse('Too many chain reads (chain_rate_limited, Retry-After: 60)'),
          502: errorResponse('Contract read failed (chain_error)'),
          503: errorResponse('Soroban RPC unavailable (chain_unavailable)'),
        },
      },
    },
    '/api/v1/chain/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Read a freelancer reputation directly from Soroban (cached, 60 req/min per client)',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { $ref: '#/components/schemas/StellarAccount' } }],
        responses: {
          ...ok('On-chain reputation', { $ref: '#/components/schemas/ChainReputation' }),
          400: errorResponse('Invalid Stellar address'),
          429: errorResponse('Too many chain reads (chain_rate_limited, Retry-After: 60)'),
          502: errorResponse('Contract read failed (chain_error)'),
          503: errorResponse('Soroban RPC unavailable (chain_unavailable)'),
        },
      },
    },
    '/api/cron/index-events': {
      get: {
        tags: ['Cron'],
        summary: 'Index a batch of escrow contract events (Vercel cron; also accepts POST)',
        description: 'Requires `Authorization: Bearer <CRON_SECRET>`; fails closed with 401 when CRON_SECRET is unset.',
        parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Indexing completed',
            content: json({
              type: 'object',
              properties: {
                processed: { type: 'integer' },
                cursor: { type: 'string' },
                latestLedger: { type: 'integer' },
              },
            }),
          },
          401: { description: 'Unauthorized - missing or invalid CRON_SECRET' },
          409: { description: 'Conflict - indexer already running' },
        },
      },
    },
    '/api/v1/chain/events': {
      get: {
        tags: ['Events'],
        summary: 'List indexed contract events',
        parameters: [
          { name: 'escrowId', in: 'query', schema: { type: 'string' }, description: 'Filter by escrow ID' },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by event type' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 }, description: 'Max events to return (default 50)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Pagination cursor' },
        ],
        responses: ok('Events', {
          type: 'object',
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/IndexedEvent' } },
            nextCursor: { type: 'string' },
          },
        }),
      },
    },
    '/api/v1/chain/indexer': {
      get: {
        tags: ['Events'],
        summary: 'Get indexer status',
        responses: ok('Indexer status', {
          type: 'object',
          properties: {
            cursor: { type: 'string', nullable: true },
            lastRunAt: { type: 'string', nullable: true },
            lastError: { type: 'string', nullable: true },
            eventsStored: { type: 'integer' },
            lagLedgers: { type: 'integer' },
          },
        }),
      },
    },
    '/api/v1/parties/{address}/statement.csv': {
      get: {
        tags: ['Parties'],
        summary: 'CSV escrow activity statement for an address',
        description:
          'Streams a RFC 4180 CSV file of all escrow contracts where the address is client or ' +
          'freelancer, filtered by creation date. Cells beginning with `=`, `+`, `-`, `@`, tab, ' +
          'or CR are prefixed with `\'` to prevent spreadsheet formula injection.',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Stellar address' },
          {
            name: 'from',
            in: 'query',
            schema: { type: 'string', format: 'date' },
            description: 'Inclusive start date (ISO 8601, e.g. 2024-01-01). Defaults to 365 days before `to`.',
          },
          {
            name: 'to',
            in: 'query',
            schema: { type: 'string', format: 'date' },
            description: 'Exclusive end date (ISO 8601). Defaults to today (UTC). Max range 3 years.',
          },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string', enum: ['client', 'freelancer', 'all'], default: 'all' },
            description: 'Filter rows by the address\'s role in each contract.',
          },
          {
            name: 'bom',
            in: 'query',
            schema: { type: 'boolean', default: false },
            description: 'Prepend a UTF-8 BOM (U+FEFF) for Excel compatibility.',
          },
        ],
        responses: {
          200: {
            description: 'CSV statement',
            headers: {
              'Content-Disposition': {
                schema: { type: 'string' },
                description: 'attachment; filename="talenttrust-<address>-<from>-<to>.csv"',
              },
            },
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          400: {
            description: 'Invalid date range or role parameter',
            content: json({ type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }),
          },
        },
      },
    },
    '/api/v1/parties/{address}/statement.json': {
      get: {
        tags: ['Parties'],
        summary: 'JSON escrow activity statement for an address',
        description: 'Same rows as the CSV endpoint, returned as JSON for programmatic use.',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Stellar address' },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive start date.' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Exclusive end date.' },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string', enum: ['client', 'freelancer', 'all'], default: 'all' },
          },
        ],
        responses: {
          200: {
            description: 'JSON statement',
            content: json({
              type: 'object',
              properties: {
                address: { type: 'string' },
                from: { type: 'string', format: 'date-time' },
                to: { type: 'string', format: 'date-time' },
                role: { type: 'string' },
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/StatementRow' },
                },
              },
            }),
          },
          400: {
            description: 'Invalid date range or role parameter',
            content: json({ type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }),
          },
        },
      },
    },
    '/api/v1/state-machine': {
      get: {
        tags: ['Contracts'],
        summary: 'Escrow lifecycle transition table and Mermaid diagram',
        description:
          'The same table the store enforces. `actorEnforced` is true only where the store itself checks the caller ' +
          '(dispute); client-only actions are enforced for wallet-authenticated callers and resolve by scoped API keys. ' +
          'Errors are reported in `checkOrder`: existence, actor, status, guards.',
        responses: ok('State machine', { $ref: '#/components/schemas/StateMachine' }),
      },
    },
    '/api/v1/contracts/{id}/actions': {
      get: {
        tags: ['Contracts'],
        summary: 'Actions currently allowed on a contract',
        description:
          'For each action: whether it is allowed now, otherwise the error code and reason the mutation would return, ' +
          'plus `maxDeposit` (remaining funding capacity, base units) and releasable milestone indexes. `as` is an ' +
          'advisory caller address used only for the dispute party check.',
        parameters: [idParam, { name: 'as', in: 'query', required: false, schema: { type: 'string', minLength: 1 } }],
        responses: {
          ...ok('Allowed actions', { $ref: '#/components/schemas/AllowedActions' }),
          400: errorResponse('Invalid id or `as` (invalid_actor)'),
          404: errorResponse('Contract not found'),
        },
      },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: ok('Stats', { type: 'object', properties: { contracts: { type: 'integer' }, byStatus: { type: 'object' }, totalEscrowed: { description: 'DEPRECATED — lossy above 2^53. Use totalEscrowedUnits.', oneOf: [{ type: 'number' }] }, totalEscrowedUnits: { type: 'string', description: 'Total escrowed in token base units (bigint-safe decimal string).' }, totalReleased: { description: 'DEPRECATED — lossy above 2^53. Use totalReleasedUnits.', oneOf: [{ type: 'number' }] }, totalReleasedUnits: { type: 'string', description: 'Total released in token base units (bigint-safe decimal string).' } } }) } },
    '/api/v1/tx/build': {
      post: {
        tags: ['Transaction'],
        summary: 'Build a simulated, unsigned Soroban transaction for an escrow action',
        description:
          'Assembles an unsigned invokeHostFunction transaction against the configured escrow contract, ' +
          'simulates it via Soroban RPC, and returns the assembled XDR ready for a wallet (Freighter, xBull, …) ' +
          'to sign. The server never holds or requires user secret keys. `source` must be the Stellar account ' +
          'that the contract will `require_auth` (client for create/deposit/release/cancel/issue_reputation, ' +
          'caller for open_dispute). `resolve_dispute` and `set_paused` are admin-only and not buildable.',
        requestBody: {
          required: true,
          content: json({ $ref: '#/components/schemas/TxBuildRequest' }),
        },
        responses: {
          200: { description: 'Simulated, assembled unsigned transaction', content: json({ $ref: '#/components/schemas/TxBuildResponse' }) },
          400: errorResponse('Invalid action, source, or args; or source does not match the party the contract will require_auth (source_mismatch)', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          403: errorResponse('Admin-only action (resolve_dispute, set_paused) is not buildable', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          404: errorResponse('Source account not found on chain', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          422: errorResponse('Contract simulation failed (contract_error)', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          503: errorResponse('Stellar RPC unavailable', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
        },
      },
    },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts with cursor pagination, sorting and filters',
        description:
          'Returns a page of contracts (`data`) plus `page: { limit, nextCursor, hasMore }`. Pass ' +
          '`page.nextCursor` back as `cursor` (with the same `sort`) for the next page; ties are broken by id. ' +
          'Use `?fields=` to request a sparse response — only the listed fields are included, ' +
          'reducing payload size for list views.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, description: 'Page size' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque cursor returned in `page.nextCursor`' },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'totalAmount', '-totalAmount'], default: '-createdAt' }, description: 'Sort field and direction' },
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma-separated list of statuses (Created, Funded, Completed, Disputed, Resolved, Cancelled, Expired)' },
          { name: 'party', in: 'query', schema: { $ref: '#/components/schemas/StellarAccount' }, description: 'Client or freelancer account (validated and normalised)' },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['client', 'freelancer'] }, description: 'Restricts `party` to the given role; requires `party`' },
          { name: 'token', in: 'query', schema: { type: 'string' }, description: 'Exact token match' },
          { name: 'createdAfter', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'ISO-8601 lower bound on createdAt' },
          { name: 'createdBefore', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'ISO-8601 upper bound on createdAt' },
          fieldsParam,
          { name: 'linked', in: 'query', schema: { type: 'boolean' }, description: 'Filter by whether contract is linked to on-chain escrow' },
        ],
        responses: {
          ...ok('Paginated contracts', {
            type: 'object',
            required: ['data', 'page'],
            properties: {
              data: { type: 'array', items: contractRef },
              page: {
                type: 'object',
                required: ['limit', 'hasMore'],
                properties: {
                  limit: { type: 'integer' },
                  nextCursor: { type: 'string', nullable: true },
                  hasMore: { type: 'boolean' },
                },
              },
            },
          }),
          400: errorResponse('invalid_query, invalid_cursor, invalid party address (invalid_address) or invalid `?fields=` value'),
        },
      },
      post: {
        tags: ['Contracts'],
        summary: 'Create an escrow contract',
        parameters: [receiptQueryParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client', 'freelancer'],
            properties: {
              title: { type: 'string' },
              client: { $ref: '#/components/schemas/StellarAccount' },
              freelancer: { $ref: '#/components/schemas/StellarAccount' },
              token: {
                description:
                  'Token contract address (C…), or `native` / `XLM` for the network native asset. ' +
                  'Stored as the resolved SAC contract id; the original symbol is exposed as tokenSymbol.',
                oneOf: [
                  { $ref: '#/components/schemas/ContractAddress' },
                  { type: 'string', enum: ['native', 'XLM'] },
                ],
                default: 'native',
              },
              fundingDeadline: {
                type: 'string',
                format: 'date-time',
                description: 'ISO-8601 deadline, from 1 hour through 90 days after creation (default 14 days)',
              },
              templateId: {
                type: 'integer',
                description: 'Create from a milestone template instead of `milestones` (exactly one of the two is required)',
              },
              budget: {
                ...amountSchema,
                description: 'Total budget in base units; required for percent templates, forbidden otherwise',
              },
              milestones: milestonesSchema,
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          400: errorResponse(
            'Invalid contract input: client/freelancer must be G… accounts (invalid_address), ' +
              'parties must differ after normalisation (invalid_parties), and token must be a C… contract ' +
              'or native/XLM (invalid_address).',
          ),
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: {
        tags: ['Contracts'],
        summary: 'Get a contract',
        description:
          'Returns a single contract by numeric ID. ' +
          'Use `?fields=` to request only a subset of fields.',
        parameters: [idParam, fieldsParam],
        responses: {
          ...ok('Contract', contractRef),
          400: errorResponse('Invalid contract id or invalid `?fields=` value'),
          404: errorResponse('Contract not found'),
        },
      },
      patch: {
        tags: ['Contracts'],
        summary: 'Edit an unfunded contract',
        description: 'Only the matching client can edit a contract while it is Created and has received no funds.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client'],
            minProperties: 2,
            properties: {
              client: { type: 'string' },
              title: { type: 'string' },
              milestones: milestonesSchema,
            },
          }),
        },
        responses: {
          ...ok('Updated contract', contractRef),
          400: errorResponse('Empty patch, invalid contract id, or invalid milestones'),
          403: errorResponse('Client does not own the contract'),
          404: errorResponse('Contract not found'),
          409: errorResponse('Contract is funded or no longer editable'),
        },
      },
      delete: {
        tags: ['Contracts'],
        summary: 'Withdraw an unfunded contract',
        description: 'Only the matching client can withdraw a contract while it is Created and has received no funds.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client'],
            properties: { client: { type: 'string' } },
          }),
        },
        responses: {
          204: { description: 'Contract withdrawn' },
          400: errorResponse('Invalid contract id'),
          403: errorResponse('Client does not own the contract'),
          404: errorResponse('Contract not found'),
          409: errorResponse('Contract is funded or no longer withdrawable'),
        },
      },
    },
    '/api/v1/contracts/{id}/revisions': {
      get: {
        tags: ['Contracts'],
        summary: 'Get contract term revision history',
        parameters: [idParam],
        responses: {
          ...ok('Revision history', {
            type: 'array',
            items: { $ref: '#/components/schemas/ContractRevision' },
          }),
          400: errorResponse('Invalid contract id'),
          404: errorResponse('Contract not found'),
        },
      },
    },
    '/api/v1/contracts/{id}/receipt': {
      get: {
        tags: ['Receipts'],
        summary: 'Get detached server-signed JWS receipt for a contract',
        parameters: [idParam],
        responses: ok('Contract receipt', {
          type: 'object',
          properties: { receipt: { type: 'string', description: 'Compact JWS receipt' } },
        }),
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { amount: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]{0,37}$', description: 'Positive decimal integer string' }], description: 'Deposit amount in token base units (e.g. stroops). Must be a positive integer.' } } }) },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, indexParam],
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/DisputeRequest' }) },
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        security: [{ apiKey: [] }],
        description:
          'Requires a scoped API key with `disputes:resolve` whenever API_KEYS is configured (fails closed in ' +
          'production without API_KEYS). 401 without/with an invalid key, 403 `insufficient_scope` otherwise.',
        tags: ['Contracts'],
        summary: 'Resolve a dispute',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/ResolveRequest' }) },
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          ...errorResponses,
          401: errorResponse('Missing or invalid API key'),
          403: errorResponse('API key lacks the disputes:resolve scope (insufficient_scope)'),
        },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: { tags: ['Contracts'], summary: 'Cancel and refund', parameters: [idParam], responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses } },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        description:
          'Backward-compatible endpoint. Creates a client-to-freelancer review without a comment ' +
          'and sets the contract reputationIssued flag.',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: {
          ...ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
          400: { description: 'invalid_rating', content: json(errorRef) },
          409: { description: 'already_rated or invalid_status', content: json(errorRef) },
        },
      },
    },
    '/api/v1/contracts/{id}/reviews': {
      post: {
        tags: ['Reputation'],
        summary: 'Create a review for a contract (client or freelancer)',
        description:
          'One review per direction per contract. The reviewer must be a party to the contract, ' +
          'the contract must be Completed or Resolved. Reviews of Resolved contracts carry ' +
          "context: 'disputed'.",
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['reviewer', 'rating'],
            properties: {
              reviewer: { type: 'string', description: 'Client or freelancer address of the contract' },
              rating: { type: 'integer', minimum: 1, maximum: 5 },
              comment: { type: 'string', maxLength: 1000, description: 'Trimmed; control characters rejected' },
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(reviewRef) },
          400: { description: 'invalid_rating or invalid_comment', content: json(errorRef) },
          403: { description: 'forbidden', content: json(errorRef) },
          404: { description: 'not_found', content: json(errorRef) },
          409: { description: 'invalid_status or already_reviewed', content: json(errorRef) },
        },
      },
    },
    '/api/v1/contracts/{id}/link': {
      post: {
        tags: ['Contracts'],
        summary: 'Link an API contract to an on-chain Soroban escrow',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['escrowId'],
            properties: {
              escrowId: { type: 'string', description: 'On-chain escrow identifier' },
            },
          }),
        },
        responses: {
          200: { description: 'Linked contract', content: json(contractRef) },
          400: errorResponse('Invalid escrow ID'),
          404: errorResponse('API contract or on-chain contract not found'),
          409: errorResponse('Already linked, on-chain escrow taken, or parameters mismatch', {
            $ref: '#/components/schemas/ChainMismatchError',
          }),
          503: errorResponse('Soroban RPC unavailable'),
        },
      },
    },
    '/api/v1/contracts/{id}/parity': {
      get: {
        tags: ['Contracts'],
        summary: 'Check state parity between API contract and linked on-chain escrow',
        parameters: [idParam],
        responses: {
          200: {
            description: 'Parity check results',
            content: json({
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['in_sync', 'drift'] },
                drift: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/DriftItem' },
                },
                checkedAt: { type: 'string', format: 'date-time' },
                latestLedger: { type: 'integer' },
              },
            }),
          },
          404: errorResponse('Contract or on-chain escrow not found'),
          409: errorResponse('Contract is not linked to an on-chain escrow'),
          503: errorResponse('Soroban RPC unavailable'),
        },
      },
    },
    '/api/v1/reputation': {
      get: {
        tags: ['Reputation'],
        summary: 'Ranked freelancer leaderboard (Bayesian score)',
        description:
          'score = round2((C * m + totalRating) / (C + completedContracts)) with m the global mean rating (3 when there ' +
          'are none) and C = REPUTATION_PRIOR_WEIGHT (default 5). Ties break by completedContracts desc, then address.',
        parameters: [
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['score', 'completed', 'average'], default: 'score' } },
          { name: 'minCompleted', in: 'query', schema: { type: 'integer', minimum: 0, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'page.nextCursor from the previous page (same sort)' },
        ],
        responses: {
          ...ok('Leaderboard page', {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/Reputation' } },
              page: {
                type: 'object',
                properties: { limit: { type: 'integer' }, nextCursor: { type: 'string', nullable: true }, hasMore: { type: 'boolean' } },
              },
            },
          }),
          400: errorResponse('invalid_sort, invalid_min_completed, invalid_limit or invalid_cursor'),
        },
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get reputation for an address (freelancer and client)',
        description:
          'The address must be a valid G… Stellar account (checksum-validated and normalised). ' +
          'A valid account with no history returns zeros.',
        parameters: [addressParam],
        responses: {
          ...ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
          400: errorResponse('Invalid Stellar account address (invalid_address).'),
        },
      },
    },
    '/api/v1/reputation/{address}/reviews': {
      get: {
        tags: ['Reputation'],
        summary: 'List reviews received by an address, newest first',
        parameters: [
          addressParam,
          {
            name: 'role',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['client_to_freelancer', 'freelancer_to_client'] },
            description: 'Filter by review direction',
          },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'integer' }, description: 'Pagination cursor (the previous page nextCursor)' },
        ],
        responses: ok('Reviews', {
          type: 'object',
          properties: {
            reviews: { type: 'array', items: reviewRef },
            nextCursor: { type: 'integer', nullable: true },
          },
        }),
      },
    },
    '/api/v1/receipts/verify': {
      post: {
        tags: ['Receipts'],
        summary: 'Verify a server-signed JWS receipt and check against current state',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['receipt'],
            properties: { receipt: { type: 'string', description: 'Compact JWS receipt string' } },
          }),
        },
        responses: ok('Verification result', { $ref: '#/components/schemas/ReceiptVerification' }),
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Scoped API key from API_KEYS (also accepted as `Authorization: ApiKey <key>`)',
      },
      webhookAdmin: { type: 'http', scheme: 'bearer', description: 'Static WEBHOOK_ADMIN_TOKEN value' },
      adminToken: { type: 'http', scheme: 'bearer', description: 'Static ADMIN_READ_TOKEN value' },
      metricsToken: { type: 'http', scheme: 'bearer', description: 'Bearer token: METRICS_TOKEN' },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'HS256 JWT obtained via POST /api/v1/auth/token after signing a challenge.',
      },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          '1-255 printable ASCII characters. Retrying a POST with the same key and body replays the stored ' +
          'response with `Idempotent-Replayed: true` instead of applying it twice. Responses with status >= 500 ' +
          'are not stored. Keys are kept for 24h and scoped by method, path and authenticated principal ' +
          '(if any). Required when the server runs with IDEMPOTENCY_REQUIRED=true.',
        schema: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x20-\\x7e]+$' },
      },
    },
    responses: {
      MethodNotAllowed: {
        description: 'The path exists but does not support this HTTP method (`method_not_allowed`).',
        headers: {
          Allow: {
            description: 'Comma-separated list of supported methods, including HEAD for GET routes.',
            schema: { type: 'string' },
          },
        },
        content: json({ $ref: '#/components/schemas/MethodNotAllowedError' }),
      },
      NotFound: {
        description: 'No route matches the method and path (`not_found`, with `docs`)',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      InvalidIdempotencyKey: {
        description: 'Idempotency-Key is malformed (`invalid_idempotency_key`) or missing while required (`idempotency_key_required`)',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      IdempotencyConflict: {
        description:
          '`idempotency_request_in_progress`: a request with this key is still running (see `Retry-After`). ' +
          'Other 409 codes are business-rule conflicts such as `over_funded`.',
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying' } },
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      IdempotencyKeyReused: {
        description: '`idempotency_key_reused`: the key was already used with a different request body',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
    },
    schemas: {
      StellarAccount: {
        type: 'string',
        pattern: '^G[A-Z2-7]{55}$',
        description:
          'Stellar ed25519 account address (strkey with a valid checksum). Muxed M… accounts are rejected.',
        example: 'GACE4EDG4UIAAELYTPAXRIFNNTKNUQYYLWFCWWNTOHNN5PEFVGQXEOYC',
      },
      ContractAddress: {
        type: 'string',
        pattern: '^C[A-Z2-7]{55}$',
        description: 'Stellar contract address (C… strkey with a valid checksum), such as a SAC token id.',
        example: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
      AllowedActions: {
        type: 'object',
        required: ['status', 'actions'],
        properties: {
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled', 'Expired'] },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['action', 'allowed'],
              properties: {
                action: { type: 'string', enum: ['deposit', 'release', 'dispute', 'resolve', 'cancel', 'rate'] },
                allowed: { type: 'boolean' },
                code: { type: 'string', description: 'Error code the mutation would return when not allowed' },
                reason: { type: 'string' },
                params: {
                  type: 'object',
                  properties: {
                    maxDeposit: { type: 'string', description: 'Remaining funding capacity in base units' },
                    index: { type: 'array', items: { type: 'integer' }, description: 'Releasable milestone indexes' },
                  },
                },
              },
            },
          },
        },
      },
      StateMachine: {
        type: 'object',
        required: ['checkOrder', 'transitions', 'mermaid'],
        properties: {
          checkOrder: { type: 'array', items: { type: 'string' } },
          transitions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                from: { type: 'array', items: { type: 'string' } },
                actor: { type: 'string', enum: ['client', 'freelancer', 'party', 'admin'] },
                actorEnforced: { type: 'boolean' },
                next: { type: 'object', properties: { status: { type: 'string' }, when: { type: 'string' } } },
              },
            },
          },
          mermaid: { type: 'string', description: 'Mermaid stateDiagram-v2 source' },
        },
      },
      StatementRow: {
        type: 'object',
        description: 'One row in an escrow activity statement.',
        properties: {
          contract_id: { type: 'string', description: 'Contract ID' },
          title: { type: 'string', description: 'Contract title' },
          role: { type: 'string', enum: ['client', 'freelancer'], description: 'Role of the queried address' },
          counterparty: { type: 'string', description: 'The other party\'s Stellar address' },
          token: { type: 'string', description: 'Token symbol (e.g. XLM)' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled', 'Expired'] },
          total_amount: { type: 'number', description: 'Sum of all milestone amounts' },
          funded_amount: { type: 'number', description: 'Total deposited into escrow' },
          released_amount: { type: 'number', description: 'Total released to freelancer' },
          outstanding_amount: { type: 'number', description: 'Still held in escrow: funded_amount − released_amount while live, 0 once resolved, cancelled or expired' },
          total_amount_units: { type: 'string', description: 'Exact total in base units (the CSV uses these exact values)' },
          funded_amount_units: { type: 'string' },
          released_amount_units: { type: 'string' },
          outstanding_amount_units: { type: 'string' },
          dispute_freelancer_bps: {
            type: 'number',
            nullable: true,
            description: 'Freelancer share in basis points if the contract was resolved via dispute; null otherwise',
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      IndexedEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ledger: { type: 'integer' },
          ledgerClosedAt: { type: 'string' },
          txHash: { type: 'string' },
          event: {
            oneOf: [
              { $ref: '#/components/schemas/CreatedEvent' },
              { $ref: '#/components/schemas/DepositEvent' },
              { $ref: '#/components/schemas/ReleaseEvent' },
              { $ref: '#/components/schemas/DisputeEvent' },
              { $ref: '#/components/schemas/ResolvedEvent' },
              { $ref: '#/components/schemas/CancelEvent' },
              { $ref: '#/components/schemas/ReputationEvent' },
              { $ref: '#/components/schemas/PausedEvent' },
              { $ref: '#/components/schemas/InitEvent' },
              { $ref: '#/components/schemas/UnknownEvent' },
            ],
          },
        },
      },
      CreatedEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Created'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              client: { type: 'string' },
              freelancer: { type: 'string' },
              total: { type: 'string' },
            },
          },
        },
      },
      DepositEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Deposit'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              amount: { type: 'string' },
            },
          },
        },
      },
      ReleaseEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Release'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              index: { type: 'integer' },
              amount: { type: 'string' },
            },
          },
        },
      },
      DisputeEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Dispute'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              caller: { type: 'string' },
            },
          },
        },
      },
      ResolvedEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Resolved'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              toFreelancer: { type: 'string' },
              toClient: { type: 'string' },
            },
          },
        },
      },
      CancelEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Cancel'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              refund: { type: 'string' },
            },
          },
        },
      },
      ReputationEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Reputation'] },
          data: {
            type: 'object',
            properties: {
              escrowId: { type: 'string' },
              freelancer: { type: 'string' },
              rating: { type: 'integer' },
            },
          },
        },
      },
      PausedEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Paused'] },
          data: {
            type: 'object',
            properties: {
              paused: { type: 'boolean' },
            },
          },
        },
      },
      InitEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Init'] },
          data: {
            type: 'object',
            properties: {
              admin: { type: 'string' },
            },
          },
        },
      },
      UnknownEvent: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Unknown'] },
          data: {
            type: 'object',
            properties: {
              topics: { type: 'array', items: { type: 'string' } },
              value: { type: 'string' },
            },
          },
        },
      },
      MethodNotAllowedError: {
        type: 'object',
        required: ['error', 'message', 'allowed'],
        properties: {
          error: { type: 'string', enum: ['method_not_allowed'] },
          message: { type: 'string' },
          allowed: { type: 'array', items: { type: 'string' } },
        },
      },
      WebhookSubscription: { type: 'object', required: ['id', 'url', 'events', 'active', 'createdAt', 'updatedAt'], properties: { id: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
      WebhookDelivery: { type: 'object', properties: { id: { type: 'string' }, subscriptionId: { type: 'string' }, eventId: { type: 'string' }, eventType: { type: 'string' }, status: { type: 'string' }, attempts: { type: 'integer' }, statusCode: { type: 'integer' }, lastError: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
      ChainEscrow: {
        type: 'object',
        required: ['id', 'client', 'freelancer', 'token', 'milestones', 'totalAmount', 'fundedAmount', 'releasedAmount', 'status', 'reputationIssued', 'source', 'latestLedger'],
        properties: {
          id: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: {
            type: 'array',
            items: { type: 'object', properties: { index: { type: 'integer' }, amount: { type: 'string' }, released: { type: 'boolean' } } },
          },
          totalAmount: { type: 'string', description: 'Exact i128 decimal string' },
          fundedAmount: { type: 'string' },
          releasedAmount: { type: 'string' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          reputationIssued: { type: 'boolean' },
          source: { type: 'string', enum: ['chain'] },
          latestLedger: { type: 'integer' },
        },
      },
      ChainReputation: {
        type: 'object',
        required: ['address', 'completedContracts', 'totalRating', 'averageRating', 'source'],
        properties: {
          address: { $ref: '#/components/schemas/StellarAccount' },
          completedContracts: { type: 'integer' },
          totalRating: { type: 'integer' },
          averageRating: { type: 'number' },
          source: { type: 'string', enum: ['chain'] },
        },
      },
      RelayedTransaction: {
        type: 'object',
        required: ['hash', 'function', 'submittedAt'],
        properties: {
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          function: { type: 'string' },
          submittedAt: { type: 'string', format: 'date-time' },
        },
      },
      ContractError: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string', description: 'EscrowError variant name (e.g. InvalidAmount, OverFunded)' },
          code: { type: 'integer', description: 'Numeric contract error code (1..16)' },
        },
      },
      TxStatusResponse: {
        type: 'object',
        required: ['hash', 'status', 'ledger', 'createdAt', 'function', 'returnValue'],
        properties: {
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'FAILED', 'NOT_FOUND'] },
          ledger: { type: 'integer', nullable: true },
          createdAt: { oneOf: [{ type: 'integer' }, { type: 'string' }], nullable: true },
          function: { type: 'string', nullable: true },
          returnValue: {
            nullable: true,
            description: 'Decoded native return value via scValToNative (bigints serialized as strings)',
          },
          contractError: { $ref: '#/components/schemas/ContractError' },
        },
      },
      OnChainStatus: {
        type: 'object',
        description: 'Live escrow contract state read from the Soroban RPC (cached, degrades gracefully).',
        required: ['reachable', 'fetchedAt', 'stale'],
        properties: {
          reachable: { type: 'boolean', description: 'False when the RPC could not be reached and no cached snapshot exists.' },
          latestLedger: { type: 'integer', description: 'Latest ledger seen at fetch time.' },
          version: { type: 'string', description: 'Contract version() return value.' },
          paused: { type: 'boolean', description: 'Contract is_paused() return value.' },
          contractCount: { type: 'integer', description: 'Contract contract_count() return value.' },
          admin: { type: 'string', description: 'Contract get_admin() return value.' },
          fetchedAt: { type: 'string', format: 'date-time' },
          stale: { type: 'boolean', description: 'True when serving the last good snapshot after an RPC failure.' },
          error: { type: 'string', description: 'Sanitised error summary when the last RPC read failed.' },
        },
      },
      Template: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          owner: { type: 'string' },
          name: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
          mode: { type: 'string', enum: ['fixed', 'percent'] },
          milestones: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                amount: { type: 'number', description: 'fixed mode (DEPRECATED — lossy above 2^53; use amountUnits)' },
                amountUnits: { type: 'string', description: 'fixed mode amount in base units' },
                percentBps: { type: 'integer', description: 'percent mode share; all shares sum to 10000' },
              },
            },
          },
          version: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      TemplateInput: {
        type: 'object',
        required: ['owner'],
        properties: {
          owner: { type: 'string' },
          name: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 500 },
          mode: { type: 'string', enum: ['fixed', 'percent'] },
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              oneOf: [
                { type: 'object', required: ['amount'], properties: { title: { type: 'string' }, amount: amountSchema } },
                { type: 'object', required: ['percentBps'], properties: { title: { type: 'string' }, percentBps: { type: 'integer', minimum: 1, maximum: 10000 } } },
              ],
            },
          },
        },
      },
      AuditEntry: {
        type: 'object',
        description:
          'hash = sha256(prevHash + canonicalJSON(entry without hash/prevHash)); the first entry chains from 64 zeros. ' +
          'Dispute reasons are never recorded.',
        properties: {
          seq: { type: 'integer' },
          contractId: { type: 'integer' },
          action: { type: 'string', enum: ['create', 'deposit', 'release', 'dispute', 'resolve', 'cancel', 'rate'] },
          actor: { type: 'string', nullable: true, description: 'Authenticated wallet address (or the dispute raiser)' },
          requestId: { type: 'string', nullable: true },
          at: { type: 'string', format: 'date-time' },
          before: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              fundedAmount: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use fundedAmountUnits.' },
              releasedAmount: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use releasedAmountUnits.' },
              fundedAmountUnits: { type: 'string' },
              releasedAmountUnits: { type: 'string' },
            },
          },
          after: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              fundedAmount: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use fundedAmountUnits.' },
              releasedAmount: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use releasedAmountUnits.' },
              fundedAmountUnits: { type: 'string' },
              releasedAmountUnits: { type: 'string' },
            },
          },
          details: { type: 'object' },
          prevHash: { type: 'string' },
          hash: { type: 'string' },
        },
      },
      DisputeView: {
        type: 'object',
        required: ['contractId', 'title', 'client', 'freelancer', 'raisedBy', 'raisedByRole', 'reason', 'openedAt', 'ageHours', 'held', 'heldUnits', 'slaDeadline', 'overdue'],
        properties: {
          contractId: { type: 'integer' },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          raisedBy: { type: 'string', description: 'Address that opened the dispute' },
          raisedByRole: { type: 'string', enum: ['client', 'freelancer'] },
          reason: { type: 'string', description: 'Dispute reason; only exposed on the admin routes' },
          openedAt: { type: 'string', format: 'date-time' },
          ageHours: { type: 'number', description: 'Hours since openedAt at the time of the request' },
          held: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use heldUnits.' },
          heldUnits: { type: 'string', description: 'Escrow held while the dispute is open (base units); 0 once resolved' },
          slaDeadline: { type: 'string', format: 'date-time', description: 'openedAt + DISPUTE_SLA_HOURS' },
          overdue: { type: 'boolean', description: 'True only while open and strictly past slaDeadline' },
          resolvedAt: { type: 'string', format: 'date-time' },
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
        },
      },
      DisputeQueue: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/DisputeView' } },
          summary: {
            type: 'object',
            description: 'Queue-wide totals across ALL disputes, ignoring query filters',
            properties: { open: { type: 'integer' }, overdue: { type: 'integer' }, totalHeld: { type: 'number' } },
          },
          page: {
            type: 'object',
            properties: { limit: { type: 'integer' }, count: { type: 'integer' }, nextCursor: { type: 'string', nullable: true } },
          },
        },
      },
      Problem: {
        type: 'object',
        description: 'RFC 9457 problem details. `error`/`message` duplicate the code/detail for older clients.',
        required: ['type', 'title', 'status', 'error', 'message'],
        properties: {
          type: { type: 'string', format: 'uri', description: 'https://talenttrust-backend.vercel.app/errors/<code>' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          error: { type: 'string', description: 'Machine-readable code (see GET /api/v1/errors)' },
          message: { type: 'string' },
          requestId: { type: 'string' },
          contractError: {
            type: 'object',
            properties: { name: { type: 'string' }, code: { type: 'integer' } },
            description: 'Matching Soroban contract error, when there is one',
          },
        },
      },
      PreconditionFailedResponse: {
        type: 'object',
        required: ['error', 'message', 'currentVersion'],
        properties: {
          error: { type: 'string', enum: ['precondition_failed'] },
          message: { type: 'string' },
          currentVersion: { type: 'integer' },
        },
      },
      ChallengeResponse: {
        type: 'object',
        required: ['address', 'challenge', 'expiresAt'],
        properties: {
          address: { $ref: '#/components/schemas/StellarAccount' },
          challenge: { type: 'string', description: 'Sign these exact UTF-8 bytes with the wallet key.' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      TokenRequest: {
        type: 'object',
        required: ['address', 'challenge', 'signature'],
        properties: {
          address: { $ref: '#/components/schemas/StellarAccount' },
          challenge: { type: 'string' },
          signature: { type: 'string', description: 'Base64 ed25519 signature over the challenge string.' },
        },
      },
      TokenResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      DriftItem: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Field name that drifted' },
          api: { description: 'Value in off-chain API record' },
          chain: { description: 'Value in on-chain contract' },
        },
        required: ['field', 'api', 'chain'],
      },
      ChainInfo: {
        type: 'object',
        properties: {
          escrowId: { type: 'string' },
          linkedAt: { type: 'string', format: 'date-time' },
          lastVerifiedAt: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['in_sync', 'drift', 'unverified'] },
          drift: {
            type: 'array',
            items: { $ref: '#/components/schemas/DriftItem' },
          },
        },
        required: ['escrowId', 'linkedAt', 'lastVerifiedAt', 'status', 'drift'],
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['error', 'message'],
      },
      Review: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          contractId: { type: 'integer' },
          reviewer: { type: 'string' },
          reviewee: { type: 'string' },
          role: { type: 'string', enum: ['client_to_freelancer', 'freelancer_to_client'] },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 1000 },
          context: { type: 'string', enum: ['disputed'], description: 'Present only for reviews of Resolved contracts' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Reputation: {
        type: 'object',
        properties: {
          address: { $ref: '#/components/schemas/StellarAccount' },
          completedContracts: { type: 'integer' },
          totalRating: { type: 'integer' },
          averageRating: { type: 'number' },
          score: { type: 'number', description: 'Bayesian score (see GET /api/v1/reputation)' },
          rank: { type: 'integer', nullable: true, description: '1-based rank by score; null when unrated' },
          histogram: { type: 'array', items: { type: 'integer' }, minItems: 5, maxItems: 5, description: 'Counts of 1★..5★ ratings' },
          lastRatedAt: { type: 'string', format: 'date-time', nullable: true },
          asClient: {
            type: 'object',
            properties: {
              completedContracts: { type: 'integer' },
              averageRating: { type: 'number' },
            },
          },
        },
      },
      ChainMismatchError: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          mismatches: {
            type: 'array',
            items: { $ref: '#/components/schemas/DriftItem' },
          },
        },
        required: ['error', 'message'],
      },
      PublishedKeys: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kid: { type: 'string' },
                alg: { type: 'string', enum: ['EdDSA'] },
                publicKey: { type: 'string' },
                jwk: {
                  type: 'object',
                  properties: {
                    kty: { type: 'string', enum: ['OKP'] },
                    crv: { type: 'string', enum: ['Ed25519'] },
                    x: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      ReceiptVerification: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          kid: { type: 'string', nullable: true },
          iat: { type: 'integer', nullable: true },
          contractId: { type: 'integer', nullable: true },
          matchesCurrent: { type: 'boolean' },
        },
      },
      Error: {
        type: 'object',
        description:
          'Error envelope shared by every 4xx/5xx response (served as application/problem+json, see Problem). ' +
          'Route-specific fields (details, contractError, currentVersion, docs, …) may be added.',
        required: ['error', 'message'],
        properties: {
          error: { type: 'string', description: 'Machine-readable code (see GET /api/v1/errors)' },
          message: { type: 'string' },
          requestId: { type: 'string' },
          docs: { type: 'string', description: 'Present on the global route-not-found 404' },
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
        },
      },
      Milestone: {
        type: 'object',
        required: ['index', 'title', 'amount', 'amountUnits', 'released'],
        additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 0 },
          title: { type: 'string' },
          amount: {
            description: 'DEPRECATED — lossy above 2^53. Use amountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          amountUnits: {
            type: 'string',
            description: 'Canonical decimal string amount in token base units (e.g. stroops).',
          },
          released: { type: 'boolean' },
        },
      },
      Dispute: {
        type: 'object',
        required: ['raisedBy', 'openedAt'],
        additionalProperties: false,
        properties: {
          raisedBy: { type: 'string' },
          reason: { type: 'string', description: 'Confidential: only returned by the admin dispute routes' },
          openedAt: { type: 'string', format: 'date-time' },
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
          resolvedAt: { type: 'string', format: 'date-time' },
          resolvedBy: { type: 'string', description: 'Id of the scoped API key that resolved the dispute' },
        },
      },
      ServiceInfo: {
        type: 'object',
        required: ['name', 'version', 'description', 'docs', 'openapi', 'endpoints'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          docs: { type: 'string' },
          openapi: { type: 'string' },
          website: { type: 'string' },
          chain: {
            type: 'object',
            properties: { network: { type: 'string' }, contractId: { type: 'string' }, explorer: { type: 'string' } },
          },
          endpoints: { type: 'array', items: { type: 'string' } },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'version', 'uptimeSeconds', 'storage', 'timestamp'],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          version: { type: 'string' },
          uptimeSeconds: { type: 'integer', minimum: 0 },
          storage: { type: 'string' },
          paused: { type: 'boolean' },
          pauseSource: { type: 'string', enum: ['chain', 'env', 'none'] },
          timestamp: { type: 'string', format: 'date-time' },
          checks: {
            type: 'object',
            description: 'Summary of the last readiness run, present once one has completed.',
            additionalProperties: { $ref: '#/components/schemas/HealthCheck' },
          },
        },
      },
      Liveness: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: { status: { type: 'string', enum: ['ok'] } },
      },
      HealthCheck: {
        type: 'object',
        required: ['status', 'latencyMs'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['pass', 'fail', 'warn'] },
          latencyMs: { type: 'number', minimum: 0 },
          detail: { type: 'string', description: 'Fixed string such as "timeout" or a mismatch explanation.' },
        },
      },
      Readiness: {
        type: 'object',
        required: ['status', 'checks', 'checkedAt'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ready', 'degraded', 'unready'] },
          checks: {
            type: 'object',
            description: 'rpc, network, contract and storage results.',
            additionalProperties: { $ref: '#/components/schemas/HealthCheck' },
          },
          checkedAt: { type: 'string', format: 'date-time' },
        },
      },
      EscrowContract: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'title',
          'client',
          'freelancer',
          'token',
          'tokenSymbol',
          'milestones',
          'totalAmount',
          'totalAmountUnits',
          'fundedAmount',
          'fundedAmountUnits',
          'releasedAmount',
          'releasedAmountUnits',
          'status',
          'reputationIssued',
          'revision',
          'version',
          'fundingDeadline',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          client: { $ref: '#/components/schemas/StellarAccount' },
          freelancer: { $ref: '#/components/schemas/StellarAccount' },
          token: { $ref: '#/components/schemas/ContractAddress' },
          tokenSymbol: {
            type: 'string',
            nullable: true,
            enum: ['XLM', null],
            description: 'Token symbol when the token is the native asset; null for other SAC tokens.',
          },
          milestones: { type: 'array', items: { $ref: '#/components/schemas/Milestone' } },
          totalAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use totalAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          totalAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string total in token base units.',
          },
          fundedAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use fundedAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          fundedAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string funded amount in token base units.',
          },
          releasedAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use releasedAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          releasedAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string released amount in token base units.',
          },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled', 'Expired'] },
          reputationIssued: { type: 'boolean' },
          fundingDeadline: { type: 'string', format: 'date-time' },
          expiredAt: { type: 'string', format: 'date-time' },
          refundableAmount: { type: 'number', description: 'DEPRECATED — lossy above 2^53. Use refundableAmountUnits.' },
          refundableAmountUnits: { type: 'string', description: 'Partial funding returned to the client on expiry (base units).' },
          dispute: { $ref: '#/components/schemas/Dispute' },
          chain: { $ref: '#/components/schemas/ChainInfo' },
          revision: { type: 'integer', minimum: 1, description: 'Term revision; increments on every edit.' },
          templateId: { type: 'integer', description: 'Template the milestones were generated from' },
          templateVersion: { type: 'integer', description: 'Template version used at creation' },
          version: { type: 'integer', minimum: 1, description: 'Entity version behind the ETag; increments on every state change.' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      TxBuildRequest: {
        type: 'object',
        required: ['action', 'source', 'args'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_contract',
              'deposit_funds',
              'release_milestone',
              'open_dispute',
              'cancel_contract',
              'issue_reputation',
            ],
          },
          source: { type: 'string', description: 'Stellar account (G…) that will sign the transaction' },
          args: {
            oneOf: [
              {
                type: 'object',
                description: 'create_contract',
                required: ['client', 'freelancer', 'token', 'milestoneAmounts'],
                properties: {
                  client: { type: 'string', description: 'Stellar address' },
                  freelancer: { type: 'string', description: 'Stellar address' },
                  token: { type: 'string', description: 'Stellar asset/token address' },
                  milestoneAmounts: {
                    type: 'array',
                    items: { type: 'string', description: 'decimal string within i128 range' },
                    minItems: 1,
                    maxItems: 20,
                  },
                },
              },
              {
                type: 'object',
                description: 'deposit_funds',
                required: ['id', 'amount'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  amount: { type: 'string', description: 'decimal string within i128 range' },
                },
              },
              {
                type: 'object',
                description: 'release_milestone',
                required: ['id', 'index'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  index: { type: 'integer', minimum: 0, description: 'u32 milestone index' },
                },
              },
              {
                type: 'object',
                description: 'open_dispute',
                required: ['id', 'caller'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  caller: { type: 'string', description: 'Stellar address opening the dispute' },
                },
              },
              {
                type: 'object',
                description: 'cancel_contract',
                required: ['id'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                },
              },
              {
                type: 'object',
                description: 'issue_reputation',
                required: ['id', 'rating'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  rating: { type: 'integer', minimum: 0, description: 'u32 reputation rating' },
                },
              },
            ],
          },
        },
      },
      TxBuildResponse: {
        type: 'object',
        properties: {
          xdr: { type: 'string', description: 'Base64 unsigned transaction envelope XDR' },
          networkPassphrase: { type: 'string' },
          fee: {
            type: 'object',
            properties: {
              inclusion: { type: 'string', description: 'Classic inclusion fee (stroops)' },
              resource: { type: 'string', description: 'Soroban resource fee (stroops)' },
              total: { type: 'string', description: 'Total fee (stroops)' },
            },
          },
          minResourceFee: { type: 'string', description: 'Minimum resource fee from simulation (stroops)' },
          latestLedger: { type: 'integer' },
          expiresAt: { type: 'string', format: 'date-time', description: 'Approximate transaction expiry from timebounds' },
          authRequired: {
            type: 'array',
            items: { type: 'string' },
            description: 'Addresses whose Soroban auth entries the wallet must sign',
          },
        },
      },
      TxBuildErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            enum: [
              'invalid_action',
              'invalid_source',
              'invalid_args',
              'source_mismatch',
              'admin_action_not_buildable',
              'source_account_not_found',
              'contract_error',
              'simulation_failed',
              'chain_unavailable',
            ],
          },
          message: { type: 'string' },
          contractError: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              code: { type: 'integer' },
            },
            description: 'Present only for contract_error responses',
          },
          requestId: { type: 'string' },
        },
      },
      ContractRevision: {
        type: 'object',
        required: ['revision', 'at', 'changes'],
        properties: {
          revision: { type: 'integer', minimum: 2 },
          at: { type: 'string', format: 'date-time' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'from', 'to'],
              properties: {
                field: { type: 'string', enum: ['title', 'milestones'] },
                from: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
              },
            },
          },
        },
      },
      ValidationError: {
        type: 'object',
        properties: {
          error: { type: 'string', enum: ['validation_failed'] },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['path', 'message'],
            },
          },
        },
        required: ['error', 'message', 'details'],
      },
      CreateContractRequest: {
        type: 'object',
        required: ['client', 'freelancer', 'milestones'],
        properties: {
          title: { type: 'string', maxLength: 120 },
          client: { type: 'string', minLength: 1 },
          freelancer: { type: 'string', minLength: 1 },
          token: { type: 'string', maxLength: 64 },
          fundingDeadline: { type: 'string', format: 'date-time' },
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              oneOf: [
                amountSchema,
                {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: 120 },
                    amount: amountSchema,
                  },
                  required: ['amount'],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
      DepositRequest: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: amountSchema,
        },
        additionalProperties: false,
      },
      DisputeRequest: {
        type: 'object',
        required: ['raisedBy'],
        properties: {
          raisedBy: { $ref: '#/components/schemas/StellarAccount' },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        additionalProperties: false,
      },
      ResolveRequest: {
        type: 'object',
        required: ['freelancerBps'],
        properties: {
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
        },
        additionalProperties: false,
      },
      RateRequest: {
        type: 'object',
        required: ['rating'],
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  },
};

type Operation = { parameters?: object[]; responses: Record<string, object> };

/** Documents Idempotency-Key and its error statuses on every POST operation. */
function withIdempotency<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, { post?: Operation }>;
  for (const item of Object.values(paths)) {
    const op = item.post;
    if (!op) continue;
    op.parameters = [...(op.parameters ?? []), { $ref: '#/components/parameters/IdempotencyKey' }];
    op.responses = {
      ...op.responses,
      400: { $ref: '#/components/responses/InvalidIdempotencyKey' },
      409: { $ref: '#/components/responses/IdempotencyConflict' },
      422: { $ref: '#/components/responses/IdempotencyKeyReused' },
    };
  }
  return doc;
}

/** Operations that accept (and, when enabled, require) a wallet bearer token. */
const PROTECTED: Array<[string, string]> = [
  ['/api/v1/contracts', 'post'],
  ['/api/v1/contracts/{id}', 'patch'],
  ['/api/v1/contracts/{id}', 'delete'],
  ['/api/v1/contracts/{id}/deposit', 'post'],
  ['/api/v1/contracts/{id}/extend-deadline', 'post'],
  ['/api/v1/contracts/{id}/milestones/{index}/release', 'post'],
  ['/api/v1/contracts/{id}/dispute', 'post'],
  ['/api/v1/contracts/{id}/cancel', 'post'],
  ['/api/v1/contracts/{id}/reputation', 'post'],
  ['/api/v1/contracts/{id}/reviews', 'post'],
];

/** Adds bearerAuth security plus 401/403 responses to every protected operation. */
function withBearerAuth<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, Record<string, (Operation & { security?: object[] }) | undefined>>;
  for (const [path, method] of PROTECTED) {
    const op = paths[path]?.[method];
    if (!op) continue;
    op.security = [{ bearerAuth: [] }];
    op.responses = {
      ...op.responses,
      401: errorResponse('Missing or invalid bearer token.'),
      403: errorResponse('Authenticated caller is not the required party for this operation.'),
    };
  }
  return doc;
}

/** Mutations that accept `?receipt=true` and then return a signed `Receipt` header. */
const RECEIPT_OPS = [
  '/api/v1/contracts',
  '/api/v1/contracts/{id}/deposit',
  '/api/v1/contracts/{id}/milestones/{index}/release',
  '/api/v1/contracts/{id}/dispute',
  '/api/v1/contracts/{id}/resolve',
  '/api/v1/contracts/{id}/cancel',
  '/api/v1/contracts/{id}/reputation',
];

/** Documents the `receipt` query parameter and `Receipt` response header on receipt-capable mutations. */
function withReceipts<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, { post?: Operation }>;
  for (const path of RECEIPT_OPS) {
    const op = paths[path]?.post;
    if (!op) continue;
    if (!(op.parameters ?? []).includes(receiptQueryParam)) op.parameters = [...(op.parameters ?? []), receiptQueryParam];
    for (const code of ['200', '201']) {
      const r = op.responses[code] as { $ref?: string; headers?: object } | undefined;
      if (r && !r.$ref) r.headers = { ...(r.headers ?? {}), ...receiptHeaders };
    }
  }
  return doc;
}

const etagHeader = {
  ETag: { description: 'Strong entity tag (`"<id>-<version>"` for a contract)', schema: { type: 'string' } },
};
const ifNoneMatchHeader = {
  name: 'If-None-Match',
  in: 'header',
  required: false,
  description: 'Entity tag(s) from a previous response; returns 304 Not Modified when current',
  schema: { type: 'string' },
};
const ifMatchHeader = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description:
    'Current entity tag (`"<id>-<version>"` or `*`) for optimistic concurrency. Required when the server runs ' +
    'with REQUIRE_IF_MATCH=true.',
  schema: { type: 'string' },
};

/** Documents ETag/If-None-Match on contract reads and If-Match (412/428) on contract mutations. */
function withEtags<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, Record<string, Operation | undefined>>;
  for (const path of ['/api/v1/contracts', '/api/v1/contracts/{id}']) {
    const op = paths[path]?.get;
    if (!op) continue;
    op.parameters = [...(op.parameters ?? []), ifNoneMatchHeader];
    const r = op.responses['200'] as { headers?: object } | undefined;
    if (r) r.headers = { ...(r.headers ?? {}), ...etagHeader };
    op.responses = { ...op.responses, 304: { description: 'Not Modified - cached representation is current' } };
  }
  const mutations: Array<[string, string]> = [
    ['/api/v1/contracts/{id}', 'patch'],
    ['/api/v1/contracts/{id}', 'delete'],
    ['/api/v1/contracts/{id}/extend-deadline', 'post'],
    ['/api/v1/contracts/{id}/deposit', 'post'],
    ['/api/v1/contracts/{id}/milestones/{index}/release', 'post'],
    ['/api/v1/contracts/{id}/dispute', 'post'],
    ['/api/v1/contracts/{id}/resolve', 'post'],
    ['/api/v1/contracts/{id}/cancel', 'post'],
    ['/api/v1/contracts/{id}/reputation', 'post'],
  ];
  for (const [path, method] of mutations) {
    const op = paths[path]?.[method];
    if (!op) continue;
    op.parameters = [...(op.parameters ?? []), ifMatchHeader];
    const r = op.responses['200'] as { $ref?: string; headers?: object } | undefined;
    if (r && !r.$ref) r.headers = { ...(r.headers ?? {}), ...etagHeader };
    op.responses = {
      ...op.responses,
      412: {
        description: 'Precondition Failed - If-Match does not match the current ETag',
        headers: etagHeader,
        content: json({ $ref: '#/components/schemas/PreconditionFailedResponse' }),
      },
      428: errorResponse('Precondition Required - If-Match missing while REQUIRE_IF_MATCH=true'),
    };
  }
  const created = (paths['/api/v1/contracts']?.post?.responses['201'] ?? undefined) as { headers?: object } | undefined;
  if (created) created.headers = { ...(created.headers ?? {}), ...etagHeader };
  return doc;
}

const problemContent = { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } };

/**
 * Error responses are RFC 9457 problem+json: rewrite every inline 4xx/5xx
 * response (and the shared component responses) to the Problem schema, and give
 * every operation at least the generic 500.
 */
function withProblems<T extends { paths: object; components: object }>(doc: T): T {
  const toProblem = (r: { $ref?: string; content?: Record<string, { schema?: object }> }) => {
    if (r.$ref || (r as { 'x-plain-json'?: boolean })['x-plain-json']) return;
    const schema = r.content?.['application/json']?.schema as { $ref?: string } | undefined;
    // Every error documents the shared Error envelope (application/json) and the RFC 9457 view of the
    // same body (application/problem+json, what the server sends). A more specific error schema
    // (e.g. ChainMismatchError) is kept next to the Problem fields.
    const specific = schema?.$ref && !/(ErrorResponse|Error)$/.test(schema.$ref) ? schema : undefined;
    r.content = {
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      'application/problem+json': {
        schema: specific ? { allOf: [{ $ref: '#/components/schemas/Problem' }, specific] } : { $ref: '#/components/schemas/Problem' },
      },
    };
  };
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      for (const [code, r] of Object.entries(op.responses)) {
        if (/^[45]/.test(code)) toProblem(r as Parameters<typeof toProblem>[0]);
      }
      if (!op.responses['500']) {
        const internal = { description: 'Unexpected error (internal_error)', content: { ...problemContent } };
        toProblem(internal);
        op.responses = { ...op.responses, 500: internal };
      }
    }
  }
  const responses = (doc.components as { responses?: Record<string, Parameters<typeof toProblem>[0]> }).responses ?? {};
  for (const r of Object.values(responses)) toProblem(r);
  return doc;
}

/** Mutations rejected with 503 contract_paused while the escrow contract is paused. */
function withPauseGuard<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, { post?: Operation }>;
  for (const path of [
    '/api/v1/contracts',
    '/api/v1/contracts/{id}/deposit',
    '/api/v1/contracts/{id}/milestones/{index}/release',
    '/api/v1/contracts/{id}/dispute',
    '/api/v1/contracts/{id}/cancel',
  ]) {
    const op = paths[path]?.post;
    if (!op) continue;
    op.responses = {
      ...op.responses,
      503: {
        description:
          'contract_paused — the escrow contract is paused on-chain or by API_PAUSED (`Retry-After: 60`, ' +
          '`contractError: { name: "Paused", code: 4 }`)',
        headers: { 'Retry-After': { schema: { type: 'integer' } } },
        content: json({ $ref: '#/components/schemas/ErrorResponse' }),
      },
    };
  }
  return doc;
}

/** 413/415 (and invalid_body) on the routes that take a JSON body. */
function withBodyErrors<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, { post?: Operation }>;
  for (const path of [
    '/api/v1/contracts',
    '/api/v1/contracts/{id}/deposit',
    '/api/v1/contracts/{id}/dispute',
    '/api/v1/contracts/{id}/resolve',
    '/api/v1/contracts/{id}/reputation',
    '/api/v1/contracts/{id}/link',
  ]) {
    const op = paths[path]?.post;
    if (!op) continue;
    op.responses = {
      ...op.responses,
      413: errorResponse('Request body exceeds BODY_LIMIT (payload_too_large)'),
      415: errorResponse('Content-Type is not application/json, or the charset or content encoding is unsupported (unsupported_media_type)'),
    };
  }
  return doc;
}

/** Every operation can answer 405 (known path, unsupported method) with an `Allow` header. */
function withMethodNotAllowed<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      op.responses = { ...op.responses, 405: { $ref: '#/components/responses/MethodNotAllowed' } };
    }
  }
  return doc;
}

export const openapi = withMethodNotAllowed(withProblems(withBodyErrors(withPauseGuard(withEtags(withBearerAuth(withIdempotency(withReceipts(spec))))))));

const SWAGGER_VERSION = '5.17.14';
const SWAGGER_CSS = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css`;
const SWAGGER_JS = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js`;
// Subresource Integrity hashes for the pinned unpkg assets above (sha384, verified against unpkg).
const SWAGGER_CSS_SRI = 'sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn';
const SWAGGER_JS_SRI = 'sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep';

const docsInlineStyle =
  'body{margin:0;background:#fafafa}.tt-bar{background:#0f172a;color:#fff;padding:14px 24px;' +
  'font-family:system-ui,sans-serif;display:flex;gap:16px;align-items:center;flex-wrap:wrap}.tt-bar a{color:#a5b4fc}';
const docsInlineScript =
  "window.onload=function(){window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'})}";

const sha256Source = (source: string) => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;

/** CSP sources for the docs page's inline <style> and <script>, kept in sync with docsHtml. */
export const docsCsp = {
  style: sha256Source(docsInlineStyle),
  script: sha256Source(docsInlineScript),
};

export const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TalentTrust API Docs</title>
  <link rel="stylesheet" href="${SWAGGER_CSS}" integrity="${SWAGGER_CSS_SRI}" crossorigin="anonymous" />
  <style>${docsInlineStyle}</style>
</head>
<body>
  <div class="tt-bar"><strong>TalentTrust API</strong>
    <a href="/">Endpoints (JSON)</a>
    <a href="/openapi.json">openapi.json</a>
    <a href="${config.frontendUrl}">Website</a>
    <a href="${explorerUrl()}">Escrow contract on stellar.expert</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_JS}" integrity="${SWAGGER_JS_SRI}" crossorigin="anonymous"></script>
  <script>${docsInlineScript}</script>
</body>
</html>`;
