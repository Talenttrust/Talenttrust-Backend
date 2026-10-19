import { config, explorerUrl } from './config';


const json = (schema: object) => ({ 'application/json': { schema } });
const errContent = () => json({ $ref: '#/components/schemas/Error' });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const evidenceRef = { $ref: '#/components/schemas/DisputeEvidence' };

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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Disputes' }],
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
    '/api/v1/contracts/{id}/dispute/evidence': {
      post: {
        tags: ['Disputes'],
        summary: 'Submit a dispute evidence item',
        description:
          'Attaches a structured, content-hashed evidence item to an open dispute. ' +
          'Only the contract client or freelancer may submit (403 forbidden). ' +
          'Contract must be Disputed (409 dispute_not_open) and not yet resolved (409 dispute_closed). ' +
          'At most 20 items per party per dispute (409 evidence_limit_reached). ' +
          'Kind-specific fields are validated (400 invalid_evidence).',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['submittedBy', 'kind'],
            properties: {
              submittedBy: { type: 'string', description: 'Contract client or freelancer address' },
              kind: { type: 'string', enum: ['text', 'link', 'file_hash'] },
              text: { type: 'string', maxLength: 4000, description: 'Required for kind=text' },
              url: { type: 'string', format: 'uri', description: 'Required for kind=link; must be https' },
              sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Required for kind=file_hash; 64 lowercase hex' },
              fileName: { type: 'string', maxLength: 200, description: 'Optional for kind=file_hash' },
            },
          }),
        },
        responses: {
          201: { description: 'Evidence item created', content: json(evidenceRef) },
          400: { description: 'invalid_evidence', content: errContent() },
          403: { description: 'forbidden', content: errContent() },
          404: { description: 'Contract not found', content: errContent() },
          409: {
            description: 'dispute_not_open | dispute_closed | evidence_limit_reached',
            content: errContent(),
          },
        },
      },
      get: {
        tags: ['Disputes'],
        summary: 'List dispute evidence with integrity digest',
        description:
          'Returns all evidence items for the contract dispute ordered by submittedAt, ' +
          'together with digest = sha256 over the canonical JSON of all items. The digest is ' +
          'stored on the dispute as evidenceDigest when the dispute is resolved.',
        parameters: [idParam],
        responses: {
          200: {
            description: 'Evidence items and digest',
            content: json({
              type: 'object',
              required: ['data', 'digest'],
              properties: {
                data: { type: 'array', items: evidenceRef },
                digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              },
            }),
          },
          404: { description: 'Contract not found', content: errContent() },
        },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute (admin)',
        description: 'Resolving a dispute seals the current evidence digest on the dispute as evidenceDigest.',
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
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Machine-readable error code' },
          message: { type: 'string' },
        },
      },
      DisputeEvidence: {
        type: 'object',
        required: ['id', 'contractId', 'submittedBy', 'kind', 'submittedAt'],
        properties: {
          id: { type: 'string' },
          contractId: { type: 'integer' },
          submittedBy: { type: 'string' },
          kind: { type: 'string', enum: ['text', 'link', 'file_hash'] },
          text: { type: 'string', maxLength: 4000 },
          url: { type: 'string', format: 'uri' },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          fileName: { type: 'string', maxLength: 200 },
          submittedAt: { type: 'string', format: 'date-time' },
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
          dispute: {
            type: 'object',
            nullable: true,
            properties: {
              reason: { type: 'string' },
              raisedBy: { type: 'string' },
              openedAt: { type: 'string', format: 'date-time' },
              evidenceCount: { type: 'integer', description: 'Number of evidence items attached to the dispute' },
              evidenceDigest: { type: 'string', nullable: true, description: 'Sealed evidence digest set on resolution' },
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
