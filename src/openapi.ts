import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };

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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Webhooks' }],
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
              milestones: {
                type: 'array',
                items: { type: 'object', properties: { title: { type: 'string' }, amount: { type: 'number' } } },
              },
            },
          }),
        },
        responses: { 201: { description: 'Created', content: json(contractRef) } },
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
    '/api/v1/webhook-subscriptions': {
      post: {
        tags: ['Webhooks'], summary: 'Create a signed webhook subscription',
        security: [{ webhookAdmin: [] }],
        requestBody: { required: true, content: json({ type: 'object', required: ['url', 'events'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } } } }) },
        responses: { 201: { description: 'Created; the secret is returned only once' }, 400: { description: 'Invalid URL or event filter' }, 401: { description: 'Missing or invalid admin token' }, 404: { description: 'Webhooks are not configured' } },
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
  },
  components: {
    securitySchemes: { webhookAdmin: { type: 'http', scheme: 'bearer' } },
    schemas: {
      WebhookSubscription: { type: 'object', required: ['id', 'url', 'events', 'active', 'createdAt', 'updatedAt'], properties: { id: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
      WebhookDelivery: { type: 'object', properties: { id: { type: 'string' }, subscriptionId: { type: 'string' }, eventId: { type: 'string' }, eventType: { type: 'string' }, status: { type: 'string' }, attempts: { type: 'integer' }, statusCode: { type: 'integer' }, lastError: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
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
