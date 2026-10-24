import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const errorResponse = (description: string, schema: object = { $ref: '#/components/schemas/ErrorResponse' }) => ({
  description,
  content: json(schema),
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
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
      `Explorer: ${explorerUrl()}. Data is held in memory and resets on redeploy.`,
  },
  servers: [{ url: '/' }],
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }],
  paths: {
    '/health': { get: { tags: ['System'], summary: 'Health check', responses: ok('Service is healthy') } },
    '/api/v1/chain': {
      get: { tags: ['System'], summary: 'On-chain escrow contract deployment info', responses: ok('Deployment') },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: ok('Stats', { type: 'object', properties: { contracts: { type: 'integer' }, byStatus: { type: 'object' }, totalEscrowed: { description: 'DEPRECATED — lossy above 2^53. Use totalEscrowedUnits.', oneOf: [{ type: 'number' }] }, totalEscrowedUnits: { type: 'string', description: 'Total escrowed in token base units (bigint-safe decimal string).' }, totalReleased: { description: 'DEPRECATED — lossy above 2^53. Use totalReleasedUnits.', oneOf: [{ type: 'number' }] }, totalReleasedUnits: { type: 'string', description: 'Total released in token base units (bigint-safe decimal string).' } } }) } },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'party', in: 'query', schema: { type: 'string' }, description: 'Client or freelancer address' },
          { name: 'linked', in: 'query', schema: { type: 'boolean' }, description: 'Filter by whether contract is linked to on-chain escrow' },
        ],
        responses: ok('Contracts', { type: 'object', properties: { data: { type: 'array', items: contractRef } } }),
      },
      post: {
        tags: ['Contracts'],
        summary: 'Create an escrow contract',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client', 'freelancer', 'milestones'],
            properties: {
              title: { type: 'string' },
              client: { type: 'string' },
              freelancer: { type: 'string' },
              token: { type: 'string', default: 'XLM' },
              milestones: milestonesSchema,
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          400: errorResponse('Invalid contract input'),
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: {
        tags: ['Contracts'],
        summary: 'Get a contract',
        parameters: [idParam],
        responses: {
          ...ok('Contract', contractRef),
          400: errorResponse('Invalid contract id'),
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
        parameters: [idParam, { name: 'index', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam],
        requestBody: {
          content: json({ type: 'object', properties: { raisedBy: { type: 'string' }, reason: { type: 'string' } } }),
        },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { freelancerBps: { type: 'integer' } } }) },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: { tags: ['Contracts'], summary: 'Cancel and refund', parameters: [idParam], responses: ok('Updated contract', contractRef) },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: ok('Reputation'),
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
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok('Reputation'),
      },
    },
  },
  components: {
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
      Error: {
        type: 'object',
        properties: { error: { type: 'string' }, message: { type: 'string' } },
      },
      EscrowContract: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
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
          },
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
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          reputationIssued: { type: 'boolean' },
          chain: { $ref: '#/components/schemas/ChainInfo' },
          revision: { type: 'integer', minimum: 1, description: 'Term revision; increments on every edit.' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
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

export const openapi = withIdempotency(spec);

export const docsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TalentTrust API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body{margin:0;background:#fafafa}.tt-bar{background:#0f172a;color:#fff;padding:14px 24px;font-family:system-ui,sans-serif;display:flex;gap:16px;align-items:center;flex-wrap:wrap}.tt-bar a{color:#a5b4fc}</style>
</head>
<body>
  <div class="tt-bar"><strong>TalentTrust API</strong>
    <a href="/">Endpoints (JSON)</a>
    <a href="/openapi.json">openapi.json</a>
    <a href="${config.frontendUrl}">Website</a>
    <a href="${explorerUrl()}">Escrow contract on stellar.expert</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script>window.onload=function(){window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'})}</script>
</body>
</html>`;
