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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Events' }],
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
    '/api/cron/index-events': {
      post: {
        tags: ['System'],
        summary: 'Cron job to index contract events (protected by CRON_SECRET)',
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
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max events to return (default 50)' },
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
