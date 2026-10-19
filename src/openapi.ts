import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const created = (description: string, schema: object = { type: 'object' }) => ({
  201: { description, content: json(schema) },
});

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
  schema: { type: 'string', minLength: 1 },
  description: 'Stellar address',
};
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const reputationRef = { $ref: '#/components/schemas/Reputation' };

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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }],
  paths: {
    '/health': { get: { tags: ['System'], summary: 'Health check', responses: ok('Service is healthy') } },
    '/api/v1/chain': {
      get: { tags: ['System'], summary: 'On-chain escrow contract deployment info', responses: ok('Deployment') },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: ok('Stats') } },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] } },
          { name: 'party', in: 'query', schema: { type: 'string', maxLength: 64 }, description: 'Client or freelancer address' },
        ],
        responses: {
          200: { description: 'Contracts', content: json({ type: 'object', properties: { data: { type: 'array', items: contractRef } } }) },
          ...validationErrorResponse,
        },
      },
      post: {
        tags: ['Contracts'],
        summary: 'Create an escrow contract',
        requestBody: {
          required: true,
          content: json({ $ref: '#/components/schemas/CreateContractRequest' }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          ...errorResponses,
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: { tags: ['Contracts'], summary: 'Get a contract', parameters: [idParam], responses: { 200: { description: 'Contract', content: json(contractRef) }, ...errorResponses } },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/DepositRequest' }) },
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
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
        tags: ['Contracts'],
        summary: 'Resolve a dispute',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/ResolveRequest' }) },
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: { tags: ['Contracts'], summary: 'Cancel and refund', parameters: [idParam], responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses } },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/RateRequest' }) },
        responses: { 200: { description: 'Reputation', content: json(reputationRef) }, ...errorResponses },
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [addressParam],
        responses: { 200: { description: 'Reputation', content: json(reputationRef) }, ...errorResponses },
      },
    },
  },
  components: {
    schemas: {
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
                amount: { type: 'number' },
                released: { type: 'boolean' },
              },
            },
          },
          totalAmount: { type: 'number' },
          fundedAmount: { type: 'number' },
          releasedAmount: { type: 'number' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
        },
      },
      Reputation: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          completedContracts: { type: 'integer' },
          totalRating: { type: 'number' },
          averageRating: { type: 'number' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['error', 'message'],
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
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              oneOf: [
                { type: 'integer', minimum: 1 },
                {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: 120 },
                    amount: { type: 'integer', minimum: 1 },
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
          amount: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      DisputeRequest: {
        type: 'object',
        required: ['raisedBy', 'reason'],
        properties: {
          raisedBy: { type: 'string', minLength: 1 },
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