import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }, headers?: object) => ({
  200: { description, ...(headers ? { headers } : {}), content: json(schema) },
});
const errorResponse = (description: string, schema: object = { $ref: '#/components/schemas/ErrorResponse' }) => ({
  description,
  content: json(schema),
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
const preconditionFailedRef = { $ref: '#/components/schemas/PreconditionFailedResponse' };

const etagHeader = {
  ETag: {
    description: 'Entity tag for cache validation and optimistic concurrency',
    schema: { type: 'string' },
  },
};

const ifNoneMatchHeader = {
  name: 'If-None-Match',
  in: 'header',
  required: false,
  description: 'Entity tag for conditional GET; returns 304 Not Modified if matched',
  schema: { type: 'string' },
};

const ifMatchHeader = {
  name: 'If-Match',
  in: 'header',
  required: false,
  description: 'Current entity tag for optimistic concurrency precondition check (* or "<id>-<version>")',
  schema: { type: 'string' },
};

const mutationResponses = {
  200: {
    description: 'Updated contract',
    headers: etagHeader,
    content: json(contractRef),
  },
  412: {
    description: 'Precondition Failed - ETag mismatch',
    headers: etagHeader,
    content: json(preconditionFailedRef),
  },
  428: {
    description: 'Precondition Required - If-Match header missing when required',
    content: json(errorRef),
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
          { name: 'linked', in: 'query', schema: { type: 'boolean' }, description: 'Filter by whether contract is linked to on-chain escrow' },
          ifNoneMatchHeader,
        ],
        responses: {
          200: {
            description: 'Contracts',
            headers: etagHeader,
            content: json({ type: 'object', properties: { data: { type: 'array', items: contractRef } } }),
          },
          304: {
            description: 'Not Modified - cached data is current',
          },
        },
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
        responses: {
          201: {
            description: 'Created',
            headers: etagHeader,
            content: json(contractRef),
          },
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: {
        tags: ['Contracts'],
        summary: 'Get a contract',
        parameters: [idParam, ifNoneMatchHeader],
        responses: {
          200: {
            description: 'Contract',
            headers: etagHeader,
            content: json(contractRef),
          },
          304: {
            description: 'Not Modified - cached contract is current',
          },
        },
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam, ifMatchHeader],
        requestBody: { content: json({ type: 'object', properties: { amount: { type: 'number' } } }) },
        responses: mutationResponses,
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, { name: 'index', in: 'path', required: true, schema: { type: 'integer' } }, ifMatchHeader],
        responses: mutationResponses,
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam, ifMatchHeader],
        requestBody: {
          content: json({ type: 'object', properties: { raisedBy: { type: 'string' }, reason: { type: 'string' } } }),
        },
        responses: mutationResponses,
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        parameters: [idParam, ifMatchHeader],
        requestBody: { content: json({ type: 'object', properties: { freelancerBps: { type: 'integer' } } }) },
        responses: mutationResponses,
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: {
        tags: ['Contracts'],
        summary: 'Cancel and refund',
        parameters: [idParam, ifMatchHeader],
        responses: mutationResponses,
      },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam, ifMatchHeader],
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: {
          200: {
            description: 'Reputation',
            headers: etagHeader,
            content: json({ $ref: '#/components/schemas/Reputation' }),
          },
          412: mutationResponses[412],
          428: mutationResponses[428],
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
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
      },
    },
  },
  components: {
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
      PreconditionFailedResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          currentVersion: { type: 'integer' },
        },
        required: ['error', 'message', 'currentVersion'],
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
          reputationIssued: { type: 'boolean' },
          chain: { $ref: '#/components/schemas/ChainInfo' },
          version: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
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
