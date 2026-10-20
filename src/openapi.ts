import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const streamEventRef = { $ref: '#/components/schemas/StreamEvent' };

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TalentTrust API',
    version: config.version,
    description:
      'Milestone-based escrow API for freelancers and clients. State mirrors the TalentTrust ' +
      `Soroban escrow contract on Stellar ${config.network} (${config.contractId}). ` +
      `Explorer: ${explorerUrl()}. Data is held in memory and resets on redeploy. ` +
      'Live updates are available via SSE (Server-Sent Events) at /api/v1/stream; ' +
      'streams are per-process only and are closed after a short max duration so clients reconnect.',
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
    '/api/v1/stream': {
      get: {
        tags: ['Events'],
        summary: 'Subscribe to live escrow updates (Server-Sent Events)',
        description:
          'Streams contract updates as SSE events. Each event has an `id` (a monotonic sequence), ' +
          '`event: contract.created` or `contract.updated`, and a JSON `data` payload. ' +
          'Reconnect with the `Last-Event-IDh eader to replay buffered events after that id; ' +
          'if the id has been evicted from the buffer an `event: reset` sent so the client refetches. ' +
          'Comment heartbeats `: ping` are sent periodically and the stream closes after a max duration ' +
          'with `retry: 2000` so clients reconnect. This is a single-process channel; serverless instances ' +
          'do not fan out events across instances.',
        parameters: [
          { name: 'contractId', in: 'query', required: false, schema: { type: 'integer' }, description: 'Only stream events for this contract' },
          { name: 'party', in: 'query', required: false, schema: { type: 'string' }, description: 'Only stream events where this address is the client or freelancer' },
          {
            name: 'Last-Event-ID',
            in: 'header',
            required: false,
            schema: { type: 'integer' },
            description: 'Resume after this event id; replays buffered events or sends `event: reset`',
          },
        ],
        responses: {
          200: {
            description: 'Event stream',
            content: {
              'text/event-stream': { schema: { type: 'string' } },
            },
          },
          429: { description: 'Too many concurrent streams from this IP', content: json({ type: 'object', properties: { error: { type: 'string' } } }) },
          503: { description: 'Server at global stream capacity', content: json({ type: 'object', properties: { error: { type: 'string' } } }) },
        },
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
      StreamEvent: {
        type: 'object',
        description: 'Payload of a `contract.created` / `contract.updated` SSE event.',
        required: ['contractId', 'action', 'status', 'contract'],
        properties: {
          contractId: { type: 'integer' },
          action: {
            type: 'string',
            description: 'Mutation that produced the event',
            enum: ['created', 'deposit', 'release', 'dispute', 'resolve', 'cancel', 'reputation'],
          },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          contract: contractRef,
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
