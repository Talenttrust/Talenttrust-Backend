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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Parties' }],
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
    '/api/v1/parties/{address}/statement.csv': {
      get: {
        tags: ['Parties'],
        summary: 'CSV escrow activity statement for an address',
        description:
          'Streams a RFC 4180 CSV file of all escrow contracts where the address is client or ' +
          'freelancer, filtered by creation date. Cells beginning with `=`, `+`, `-`, `@`, tab, ' +
          'or CR are prefixed with `\'` to prevent spreadsheet formula injection.',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Stellar address' },
          {
            name: 'from',
            in: 'query',
            schema: { type: 'string', format: 'date' },
            description: 'Inclusive start date (ISO 8601, e.g. 2024-01-01). Defaults to 365 days before `to`.',
          },
          {
            name: 'to',
            in: 'query',
            schema: { type: 'string', format: 'date' },
            description: 'Exclusive end date (ISO 8601). Defaults to today (UTC). Max range 3 years.',
          },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string', enum: ['client', 'freelancer', 'all'], default: 'all' },
            description: 'Filter rows by the address\'s role in each contract.',
          },
          {
            name: 'bom',
            in: 'query',
            schema: { type: 'boolean', default: false },
            description: 'Prepend a UTF-8 BOM (U+FEFF) for Excel compatibility.',
          },
        ],
        responses: {
          200: {
            description: 'CSV statement',
            headers: {
              'Content-Disposition': {
                schema: { type: 'string' },
                description: 'attachment; filename="talenttrust-<address>-<from>-<to>.csv"',
              },
            },
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          400: {
            description: 'Invalid date range or role parameter',
            content: json({ type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }),
          },
        },
      },
    },
    '/api/v1/parties/{address}/statement.json': {
      get: {
        tags: ['Parties'],
        summary: 'JSON escrow activity statement for an address',
        description: 'Same rows as the CSV endpoint, returned as JSON for programmatic use.',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' }, description: 'Stellar address' },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive start date.' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Exclusive end date.' },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string', enum: ['client', 'freelancer', 'all'], default: 'all' },
          },
        ],
        responses: {
          200: {
            description: 'JSON statement',
            content: json({
              type: 'object',
              properties: {
                address: { type: 'string' },
                from: { type: 'string', format: 'date-time' },
                to: { type: 'string', format: 'date-time' },
                role: { type: 'string' },
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/StatementRow' },
                },
              },
            }),
          },
          400: {
            description: 'Invalid date range or role parameter',
            content: json({ type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }),
          },
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
      StatementRow: {
        type: 'object',
        description: 'One row in an escrow activity statement.',
        properties: {
          contract_id: { type: 'string', description: 'Contract ID' },
          title: { type: 'string', description: 'Contract title' },
          role: { type: 'string', enum: ['client', 'freelancer'], description: 'Role of the queried address' },
          counterparty: { type: 'string', description: 'The other party\'s Stellar address' },
          token: { type: 'string', description: 'Token symbol (e.g. XLM)' },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          total_amount: { type: 'number', description: 'Sum of all milestone amounts' },
          funded_amount: { type: 'number', description: 'Total deposited into escrow' },
          released_amount: { type: 'number', description: 'Total released to freelancer' },
          outstanding_amount: { type: 'number', description: 'funded_amount − released_amount' },
          dispute_freelancer_bps: {
            type: 'number',
            nullable: true,
            description: 'Freelancer share in basis points if the contract was resolved via dispute; null otherwise',
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
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
