import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const response = (description: string, schema: object) => ({ description, content: json(schema) });
const ok = (description: string, schema: object) => ({ 200: response(description, schema) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
const indexParam = { name: 'index', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } };
const addressParam = { name: 'address', in: 'path', required: true, schema: { type: 'string', minLength: 1 } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };

const ERROR_STATUS = {
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  InternalServerError: 500,
} as const;

/** `errors('BadRequest', 'Conflict')` → `{ 400: {$ref}, 409: {$ref} }`. */
const errors = (...names: (keyof typeof ERROR_STATUS)[]) =>
  Object.fromEntries(
    names.map(
      (name): [number, { $ref: string }] => [
        ERROR_STATUS[name],
        { $ref: `#/components/responses/${name}` },
      ],
    ),
  );

const contractList = {
  type: 'object',
  required: ['data'],
  properties: { data: { type: 'array', items: contractRef } },
};

const createBody = {
  type: 'object',
  required: ['client', 'freelancer', 'milestones'],
  properties: {
    title: { type: 'string', minLength: 1, description: 'Defaults to "Untitled engagement".' },
    client: { type: 'string', minLength: 1, description: 'Stellar address of the client. Must differ from freelancer.' },
    freelancer: { type: 'string', minLength: 1, description: 'Stellar address of the freelancer. Must differ from client.' },
    token: { type: 'string', minLength: 1, default: 'XLM', description: 'Token the escrow is denominated in.' },
    milestones: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: '1..20 milestones. An item is either a bare positive amount or a {title, amount} object.',
      items: {
        oneOf: [
          { type: 'number', minimum: 0, exclusiveMinimum: true },
          {
            type: 'object',
            required: ['amount'],
            properties: {
              title: { type: 'string', minLength: 1, description: 'Defaults to "Milestone <n>".' },
              amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
            },
          },
        ],
      },
    },
  },
};

const depositBody = {
  type: 'object',
  required: ['amount'],
  properties: {
    amount: {
      type: 'number',
      minimum: 0,
      exclusiveMinimum: true,
      description: 'Positive amount; may not push fundedAmount past totalAmount.',
    },
  },
};

const disputeBody = {
  type: 'object',
  required: ['raisedBy'],
  properties: {
    raisedBy: { type: 'string', minLength: 1, description: 'Client or freelancer address; anyone else gets 403.' },
    reason: { type: 'string', minLength: 1, description: 'Defaults to "No reason given".' },
  },
};

const resolveBody = {
  type: 'object',
  required: ['freelancerBps'],
  properties: {
    freelancerBps: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Basis points of the remaining escrow paid to the freelancer.',
    },
  },
};

const rateBody = {
  type: 'object',
  required: ['rating'],
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Whole-star rating for the freelancer.' },
  },
};

export const openapi = {
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
  tags: [
    { name: 'System', description: 'Service metadata, health and documentation.' },
    { name: 'Contracts', description: 'Escrow contract lifecycle: create, fund, release, dispute.' },
    { name: 'Reputation', description: 'Freelancer ratings accumulated from completed contracts.' },
  ],
  paths: {
    '/': {
      get: {
        tags: ['System'],
        summary: 'Service index',
        description: 'Service name, documentation links and the list of available endpoints.',
        responses: { ...ok('Service index', { $ref: '#/components/schemas/ServiceInfo' }), ...errors('InternalServerError') },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        responses: {
          ...ok('Service is healthy', { $ref: '#/components/schemas/Health' }),
          503: response(
            'Draining: the instance is shutting down and refuses new work',
            {
              type: 'object',
              required: ['status'],
              additionalProperties: false,
              properties: { status: { type: 'string', enum: ['draining'] } },
            },
          ),
          ...errors('InternalServerError'),
        },
      },
    },
    '/docs': {
      get: {
        tags: ['System'],
        summary: 'Interactive API reference',
        description: 'Swagger UI page for this specification.',
        responses: {
          200: {
            description: 'Swagger UI page',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
          ...errors('InternalServerError'),
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'OpenAPI document',
        responses: {
          ...ok('This document', { $ref: '#/components/schemas/OpenApiDocument' }),
          ...errors('InternalServerError'),
        },
      },
    },
    '/api/v1/chain': {
      get: {
        tags: ['System'],
        summary: 'On-chain escrow contract deployment info',
        responses: { ...ok('Deployment', { $ref: '#/components/schemas/ChainInfo' }), ...errors('InternalServerError') },
      },
    },
    '/api/v1/stats': {
      get: {
        tags: ['System'],
        summary: 'Aggregate escrow statistics',
        responses: { ...ok('Stats', { $ref: '#/components/schemas/Stats' }), ...errors('InternalServerError') },
      },
    },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact ContractStatus to filter on; unknown statuses simply match nothing.',
          },
          {
            name: 'party',
            in: 'query',
            schema: { type: 'string' },
            description: 'Client or freelancer address.',
          },
        ],
        responses: { ...ok('Contracts', contractList), ...errors('InternalServerError') },
      },
      post: {
        tags: ['Contracts'],
        summary: 'Create an escrow contract',
        requestBody: { required: true, content: json(createBody) },
        responses: {
          201: response('Created', contractRef),
          ...errors('BadRequest', 'InternalServerError'),
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
          ...errors('BadRequest', 'NotFound', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        description:
          '400 invalid_amount / invalid_id; 404 contract_not_found; ' +
          '409 invalid_status (contract not Created/Funded) or over_funded.',
        parameters: [idParam],
        requestBody: { required: true, content: json(depositBody) },
        responses: {
          ...ok('Updated contract', contractRef),
          ...errors('BadRequest', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        description:
          '400 invalid_id; 404 contract_not_found / milestone_not_found; ' +
          '409 invalid_status, already_released or insufficient_funds.',
        parameters: [idParam, indexParam],
        responses: {
          ...ok('Updated contract', contractRef),
          ...errors('BadRequest', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        description:
          '403 unauthorized when raisedBy is neither the client nor the freelancer; ' +
          '409 invalid_status when the contract is not active.',
        parameters: [idParam],
        requestBody: { required: true, content: json(disputeBody) },
        responses: {
          ...ok('Updated contract', contractRef),
          ...errors('BadRequest', 'Forbidden', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        description:
          '400 invalid_split when freelancerBps is not an integer 0..10000; ' +
          '409 invalid_status when the contract is not disputed.',
        parameters: [idParam],
        requestBody: { required: true, content: json(resolveBody) },
        responses: {
          ...ok('Updated contract', contractRef),
          ...errors('BadRequest', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: {
        tags: ['Contracts'],
        summary: 'Cancel and refund',
        description: '409 invalid_status when the contract is not Created or Funded.',
        parameters: [idParam],
        responses: {
          ...ok('Updated contract', contractRef),
          ...errors('BadRequest', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        description:
          '400 invalid_rating when rating is not an integer 1..5; ' +
          '409 invalid_status when the contract is not Completed, or already_rated.',
        parameters: [idParam],
        requestBody: { required: true, content: json(rateBody) },
        responses: {
          200: response('Reputation of the contract freelancer', { $ref: '#/components/schemas/Reputation' }),
          ...errors('BadRequest', 'NotFound', 'Conflict', 'InternalServerError'),
        },
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        description: 'Addresses with no completed contracts report zeros.',
        parameters: [addressParam],
        responses: {
          ...ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
          ...errors('InternalServerError'),
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        description: 'Error envelope returned by every non-2xx response.',
        required: ['error', 'message', 'requestId'],
        additionalProperties: false,
        properties: {
          error: { type: 'string', description: 'Stable machine-readable code, e.g. invalid_amount.' },
          message: { type: 'string', description: 'Human-readable explanation.' },
          requestId: {
            type: 'string',
            description: 'Correlation id, echoed from the X-Request-Id header when present.',
          },
          docs: { type: 'string', description: 'Documentation link; present on global route-not-found responses.' },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'version', 'uptimeSeconds', 'storage', 'timestamp'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'] },
          version: { type: 'string' },
          uptimeSeconds: { type: 'integer', minimum: 0 },
          storage: { type: 'string', description: 'Always "in-memory".' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      ServiceInfo: {
        type: 'object',
        required: ['name', 'version', 'description', 'docs', 'openapi', 'website', 'chain', 'endpoints'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          docs: { type: 'string' },
          openapi: { type: 'string' },
          website: { type: 'string' },
          chain: {
            type: 'object',
            required: ['network', 'contractId', 'explorer'],
            additionalProperties: false,
            properties: {
              network: { type: 'string' },
              contractId: { type: 'string' },
              explorer: { type: 'string' },
            },
          },
          endpoints: { type: 'array', items: { type: 'string' } },
        },
      },
      ChainInfo: {
        type: 'object',
        required: ['network', 'rpcUrl', 'contractId', 'explorer'],
        additionalProperties: false,
        properties: {
          network: { type: 'string' },
          rpcUrl: { type: 'string' },
          contractId: { type: 'string' },
          explorer: { type: 'string' },
        },
      },
      Stats: {
        type: 'object',
        required: ['contracts', 'byStatus', 'totalEscrowed', 'totalReleased'],
        additionalProperties: false,
        properties: {
          contracts: { type: 'integer', minimum: 0 },
          byStatus: {
            type: 'object',
            description: 'Contract count per ContractStatus; statuses with no contracts are omitted.',
            additionalProperties: { type: 'number' },
          },
          totalEscrowed: { type: 'number', minimum: 0, description: 'fundedAmount minus releasedAmount across contracts.' },
          totalReleased: { type: 'number', minimum: 0 },
        },
      },
      Milestone: {
        type: 'object',
        required: ['index', 'title', 'amount', 'released'],
        additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 0 },
          title: { type: 'string' },
          amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
          released: { type: 'boolean' },
        },
      },
      Dispute: {
        type: 'object',
        required: ['raisedBy', 'reason', 'openedAt'],
        additionalProperties: false,
        properties: {
          raisedBy: { type: 'string' },
          reason: { type: 'string' },
          openedAt: { type: 'string', format: 'date-time' },
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
          resolvedAt: { type: 'string', format: 'date-time' },
        },
      },
      EscrowContract: {
        type: 'object',
        required: [
          'id',
          'title',
          'client',
          'freelancer',
          'token',
          'milestones',
          'totalAmount',
          'fundedAmount',
          'releasedAmount',
          'status',
          'reputationIssued',
          'createdAt',
          'updatedAt',
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: { type: 'array', items: { $ref: '#/components/schemas/Milestone' } },
          totalAmount: { type: 'number', minimum: 0 },
          fundedAmount: { type: 'number', minimum: 0 },
          releasedAmount: { type: 'number', minimum: 0 },
          status: {
            type: 'string',
            enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'],
          },
          reputationIssued: { type: 'boolean' },
          dispute: { $ref: '#/components/schemas/Dispute' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Reputation: {
        type: 'object',
        required: ['address', 'completedContracts', 'totalRating', 'averageRating'],
        additionalProperties: false,
        properties: {
          address: { type: 'string' },
          completedContracts: { type: 'integer', minimum: 0 },
          totalRating: { type: 'number', minimum: 0 },
          averageRating: { type: 'number', minimum: 0, maximum: 5 },
        },
      },
      OpenApiDocument: {
        type: 'object',
        description: 'The OpenAPI 3.0 document served by GET /openapi.json.',
        required: ['openapi', 'info', 'paths', 'components'],
        additionalProperties: true,
        properties: {
          openapi: { type: 'string' },
          info: {
            type: 'object',
            required: ['title', 'version'],
            additionalProperties: true,
            properties: { title: { type: 'string' }, version: { type: 'string' } },
          },
          servers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name'],
              additionalProperties: true,
              properties: { name: { type: 'string' } },
            },
          },
          paths: { type: 'object', additionalProperties: { type: 'object' } },
          components: {
            type: 'object',
            additionalProperties: true,
            properties: {
              schemas: { type: 'object', additionalProperties: { type: 'object' } },
              responses: { type: 'object', additionalProperties: { type: 'object' } },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: {
        description:
          '400 — invalid input: invalid_parties, invalid_milestones, invalid_amount, ' +
          'invalid_id, invalid_split, invalid_rating, invalid_json.',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      Forbidden: {
        description: '403 — unauthorized: only the client or freelancer may open a dispute.',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      NotFound: {
        description:
          '404 — not_found (global route fallback), contract_not_found, milestone_not_found.',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      Conflict: {
        description:
          '409 — state conflict: invalid_status, over_funded, already_released, ' +
          'insufficient_funds, already_rated.',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      InternalServerError: {
        description: '500 — unexpected server error (internal_error).',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
    },
  },
};

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
