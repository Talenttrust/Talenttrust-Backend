import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const errorResponse = (description: string) => ({
  description,
  content: json({
    type: 'object',
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
    },
  }),
});
const milestonesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    oneOf: [
      { type: 'number', minimum: 0, exclusiveMinimum: true },
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
        },
        required: ['amount'],
      },
    ],
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
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'party', in: 'query', schema: { type: 'string' }, description: 'Client or freelancer address' },
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
        requestBody: { content: json({ type: 'object', properties: { amount: { type: 'number' } } }) },
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
          revision: { type: 'integer', minimum: 1 },
          revisions: {
            type: 'array',
            maxItems: 50,
            items: { $ref: '#/components/schemas/ContractRevision' },
          },
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
                from: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { $ref: '#/components/schemas/Milestone' } },
                  ],
                },
                to: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { $ref: '#/components/schemas/Milestone' } },
                  ],
                },
              },
            },
          },
        },
      },
      Milestone: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 0 },
          title: { type: 'string' },
          amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
          released: { type: 'boolean' },
        },
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
