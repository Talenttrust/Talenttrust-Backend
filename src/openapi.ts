import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const indexParam = { name: 'index', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const errorResponse = (description: string) => ({
  description,
  content: json({ $ref: '#/components/schemas/Error' }),
});

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
              reviewWindowSeconds: {
                type: 'integer',
                default: 259200,
                minimum: 3600,
                maximum: 2592000,
                description: 'Review window before a submitted milestone auto-releases.',
              },
              milestones: {
                type: 'array',
                items: { type: 'object', properties: { title: { type: 'string' }, amount: { type: 'number' } } },
              },
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          400: errorResponse(
            'Invalid input; reviewWindowSeconds must be an integer between 3600 and 2592000 (invalid_review_window)',
          ),
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: { tags: ['Contracts'], summary: 'Get a contract', parameters: [idParam], responses: ok('Contract', contractRef) },
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
    '/api/v1/contracts/{id}/milestones/{index}/submit': {
      post: {
        tags: ['Contracts'],
        summary: 'Submit a milestone deliverable for review',
        description:
          'Only the contract freelancer can submit. The contract must be Funded and the milestone pending. ' +
          'The escrow balance not already backing submitted milestones must cover this milestone.',
        parameters: [idParam, indexParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['freelancer', 'note'],
            properties: {
              freelancer: { type: 'string', description: 'Must match the contract freelancer address' },
              note: { type: 'string', maxLength: 1000 },
              url: { type: 'string', format: 'uri', pattern: '^https://', description: 'Optional HTTPS deliverable URL' },
            },
          }),
        },
        responses: {
          200: { description: 'Milestone submitted', content: json(contractRef) },
          400: errorResponse('Invalid deliverable note or url'),
          403: errorResponse('Caller is not the contract freelancer'),
          404: errorResponse('Contract or milestone not found'),
          409: errorResponse(
            'Contract is not Funded, submissions are blocked, milestone is not pending, or insufficient funds',
          ),
        },
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        description: 'Accepts pending milestones (early payment) and submitted milestones.',
        parameters: [idParam, indexParam],
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
      post: {
        tags: ['Contracts'],
        summary: 'Cancel and refund pending milestones',
        description:
          'Refunds only funds backing pending milestones. Submitted funds remain escrowed and auto-release ' +
          'after the review window, or stay frozen if a dispute is opened.',
        parameters: [idParam],
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/cron/auto-release': {
      post: {
        tags: ['System'],
        summary: 'Release milestones whose review window elapsed',
        description:
          'Sweeps all contracts and auto-releases submitted milestones at or past their review window. ' +
          'Requires an Authorization header of the form Bearer <CRON_SECRET>.',
        security: [{ CronAuth: [] }],
        responses: {
          200: {
            description: 'Sweep result',
            content: json({
              type: 'object',
              properties: {
                contracts: { type: 'integer', description: 'Contracts swept' },
                released: { type: 'integer', description: 'Milestones released by this sweep' },
              },
            }),
          },
          401: errorResponse('Missing or invalid cron secret'),
        },
      },
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
    securitySchemes: {
      CronAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
      Deliverable: {
        type: 'object',
        required: ['note'],
        properties: {
          note: { type: 'string', maxLength: 1000 },
          url: { type: 'string', format: 'uri', description: 'HTTPS URL' },
        },
      },
      Milestone: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          amount: { type: 'number' },
          status: { type: 'string', enum: ['pending', 'submitted', 'released'] },
          released: { type: 'boolean', description: 'Derived: true when status is released' },
          submittedAt: { type: 'string', format: 'date-time' },
          deliverable: { $ref: '#/components/schemas/Deliverable' },
        },
      },
      EscrowContract: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: { type: 'array', items: { $ref: '#/components/schemas/Milestone' } },
          totalAmount: { type: 'number' },
          fundedAmount: { type: 'number' },
          releasedAmount: { type: 'number' },
          reviewWindowSeconds: { type: 'integer', minimum: 3600, maximum: 2592000 },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          cancelRequestedAt: { type: 'string', format: 'date-time' },
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
