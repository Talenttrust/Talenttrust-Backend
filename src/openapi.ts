import { config, explorerUrl } from './config';
import { ERRORS, type ErrorKey } from './errors';

const json = (schema: object) => ({ 'application/json': { schema } });
const problemJson = () => ({ 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const errorResponse = (description: string, schema: object = { $ref: '#/components/schemas/ErrorResponse' }) => ({
  description,
  content: json(schema),
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };

/** Build error responses for a list of catalog keys, always including a generic 500. */
const errorResponses = (keys: ErrorKey[]) => {
  const responses: Record<string, { description: string; content: object }> = {};
  for (const key of keys) {
    const entry = ERRORS[key];
    responses[String(entry.status)] = {
      description: entry.title,
      content: problemJson(),
    };
  }
  responses['500'] = {
    description: ERRORS.internal_error.title,
    content: problemJson(),
  };
  return responses;
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
    '/health': { get: { tags: ['System'], summary: 'Health check', responses: { ...ok('Service is healthy'), ...errorResponses([]) } } },
    '/api/v1/errors': {
      get: {
        tags: ['System'],
        summary: 'List the full error catalog',
        responses: { 200: { description: 'Error catalog', content: json({ type: 'object' }) }, ...errorResponses([]) },
      },
    },
    '/errors/{code}': {
      get: {
        tags: ['System'],
        summary: 'Get a human-readable error description',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Error description', content: json({ type: 'object' }) },
          404: { description: 'Unknown error code', content: problemJson() },
        },
      },
    },
    '/api/v1/chain': {
      get: { tags: ['System'], summary: 'On-chain escrow contract deployment info', responses: { ...ok('Deployment'), ...errorResponses([]) } },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: { ...ok('Stats'), ...errorResponses([]) } } },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'party', in: 'query', schema: { type: 'string' }, description: 'Client or freelancer address' },
          { name: 'linked', in: 'query', schema: { type: 'boolean' }, description: 'Filter by whether contract is linked to on-chain escrow' },
        ],
        responses: {
          ...ok('Contracts', { type: 'object', properties: { data: { type: 'array', items: contractRef } } }),
          ...errorResponses([]),
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
          201: { description: 'Created', content: json(contractRef) },
          ...errorResponses(['invalid_parties', 'invalid_milestones', 'invalid_amount']),
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
          ...errorResponses(['contract_not_found', 'invalid_id']),
        },
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { amount: { type: 'number' } } }) },
        responses: {
          ...ok('Updated contract', contractRef),
          ...errorResponses(['contract_not_found', 'invalid_id', 'contract_not_active', 'invalid_amount', 'over_funded']),
        },
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, { name: 'index', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          ...ok('Updated contract', contractRef),
          ...errorResponses(['contract_not_found', 'invalid_id', 'contract_not_active', 'milestone_not_found', 'already_released', 'insufficient_funds']),
        },
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
        responses: {
          ...ok('Updated contract', contractRef),
          ...errorResponses(['contract_not_found', 'invalid_id', 'forbidden', 'contract_not_active']),
        },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { freelancerBps: { type: 'integer' } } }) },
        responses: {
          ...ok('Updated contract', contractRef),
          ...errorResponses(['contract_not_found', 'invalid_id', 'contract_not_disputed', 'invalid_split']),
        },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: {
        tags: ['Contracts'],
        summary: 'Cancel and refund',
        parameters: [idParam],
        responses: {
          ...ok('Updated contract', contractRef),
          ...errorResponses(['contract_not_found', 'invalid_id', 'contract_not_active']),
        },
      },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: {
          ...ok('Reputation'),
          ...errorResponses(['contract_not_found', 'invalid_id', 'contract_not_completed', 'already_rated', 'invalid_rating']),
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
        responses: { ...ok('Reputation'), ...errorResponses([]) },
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
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status', 'error', 'message'],
        properties: {
          type: { type: 'string', format: 'uri' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          error: { type: 'string' },
          message: { type: 'string' },
          contractError: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              code: { type: 'integer' },
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
