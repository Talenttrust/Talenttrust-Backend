import { config, explorerUrl } from './config';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object) => ({
  200: { description, content: json(schema) },
});
const created = (description: string, schema: object) => ({
  201: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const errorRef = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string) => ({
  description,
  content: json(errorRef),
});
const errors400 = { description: 'Bad request', content: json(errorRef) };
const errors403 = { description: 'Forbidden', content: json(errorRef) };
const errors404 = { description: 'Not found', content: json(errorRef) };
const errors409 = { description: 'Conflict', content: json(errorRef) };

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
    '/': {
      get: {
        tags: ['System'],
        summary: 'API service information',
        responses: {
          200: {
            description: 'Service info',
            content: json({ $ref: '#/components/schemas/ServiceInfo' }),
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        responses: {
          200: {
            description: 'Service is healthy',
            content: json({ $ref: '#/components/schemas/Health' }),
          },
        },
      },
    },
    '/api/v1/chain': {
      get: {
        tags: ['System'],
        summary: 'On-chain escrow contract deployment info',
        responses: {
          200: {
            description: 'Deployment',
            content: json({ $ref: '#/components/schemas/ChainInfo' }),
          },
        },
      },
    },
    '/api/v1/stats': {
      get: {
        tags: ['System'],
        summary: 'Aggregate escrow statistics',
        responses: {
          200: {
            description: 'Stats',
            content: json({ $ref: '#/components/schemas/Stats' }),
          },
        },
      },
    },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'party', in: 'query', schema: { type: 'string' }, description: 'Client or freelancer address' },
        ],
        responses: {
          200: {
            description: 'Contracts',
            content: json({ $ref: '#/components/schemas/ContractList' }),
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
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              client: { type: 'string' },
              freelancer: { type: 'string' },
              token: { type: 'string', default: 'XLM' },
              milestones: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                items: {
                  oneOf: [
                    { type: 'number', minimum: 0, exclusiveMinimum: true },
                    {
                      type: 'object',
                      required: ['amount'],
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string' },
                        amount: { type: 'number', minimum: 0, exclusiveMinimum: true },
                      },
                    },
                  ],
                },
              },
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          400: errors400,
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: {
        tags: ['Contracts'],
        summary: 'Get a contract',
        parameters: [idParam],
        responses: {
          200: { description: 'Contract', content: json(contractRef) },
          400: errors400,
          404: errors404,
        },
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['amount'],
            additionalProperties: false,
            properties: { amount: { type: 'number', minimum: 0, exclusiveMinimum: true } },
          }),
        },
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          400: errors400,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, { name: 'index', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          400: errors400,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['raisedBy'],
            additionalProperties: false,
            properties: { raisedBy: { type: 'string' }, reason: { type: 'string' } },
          }),
        },
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          400: errors400,
          403: errors403,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['freelancerBps'],
            additionalProperties: false,
            properties: { freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 } },
          }),
        },
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          400: errors400,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: {
        tags: ['Contracts'],
        summary: 'Cancel and refund',
        parameters: [idParam],
        responses: {
          200: { description: 'Updated contract', content: json(contractRef) },
          400: errors400,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['rating'],
            additionalProperties: false,
            properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } },
          }),
        },
        responses: {
          200: { description: 'Reputation', content: json({ $ref: '#/components/schemas/Reputation' }) },
          400: errors400,
          404: errors404,
          409: errors409,
        },
      },
    },
    '/api/v1/reputation/{address}': {
      get: {
        tags: ['Reputation'],
        summary: 'Get freelancer reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Reputation', content: json({ $ref: '#/components/schemas/Reputation' }) },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'OpenAPI specification',
        responses: {
          200: {
            description: 'OpenAPI 3.0 specification',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/docs': {
      get: {
        tags: ['System'],
        summary: 'API documentation',
        responses: {
          200: {
            description: 'Swagger UI',
            content: {
              'text/html': {
                schema: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  default: {
    responses: {
      '404': { description: 'Not found', content: json({ $ref: '#/components/schemas/Error' }) },
      '500': { description: 'Internal server error', content: json({ $ref: '#/components/schemas/Error' }) },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'message'],
        additionalProperties: true,
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          docs: { type: 'string' },
        },
      },
      Milestone: {
        type: 'object',
        required: ['index', 'title', 'amount', 'released'],
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          amount: { type: 'number' },
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
          openedAt: { type: 'string' },
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
          resolvedAt: { type: 'string' },
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
          id: { type: 'integer' },
          title: { type: 'string' },
          client: { type: 'string' },
          freelancer: { type: 'string' },
          token: { type: 'string' },
          milestones: {
            type: 'array',
            items: { $ref: '#/components/schemas/Milestone' },
          },
          totalAmount: { type: 'number' },
          fundedAmount: { type: 'number' },
          releasedAmount: { type: 'number' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          reputationIssued: { type: 'boolean' },
          dispute: { $ref: '#/components/schemas/Dispute' },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      ContractList: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/EscrowContract' } },
        },
      },
      Reputation: {
        type: 'object',
        required: ['address', 'completedContracts', 'totalRating', 'averageRating'],
        additionalProperties: false,
        properties: {
          address: { type: 'string' },
          completedContracts: { type: 'integer' },
          totalRating: { type: 'integer' },
          averageRating: { type: 'number' },
        },
      },
      Stats: {
        type: 'object',
        required: ['contracts', 'byStatus', 'totalEscrowed', 'totalReleased'],
        additionalProperties: false,
        properties: {
          contracts: { type: 'integer' },
          byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
          totalEscrowed: { type: 'number' },
          totalReleased: { type: 'number' },
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
      Health: {
        type: 'object',
        required: ['status', 'version', 'uptimeSeconds', 'storage', 'timestamp'],
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          version: { type: 'string' },
          uptimeSeconds: { type: 'integer' },
          storage: { type: 'string' },
          timestamp: { type: 'string' },
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
              rpcUrl: { type: 'string' },
            },
          },
          endpoints: { type: 'array', items: { type: 'string' } },
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
