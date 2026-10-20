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
  tags: [{ name: 'System' }, { name: 'Contracts' }, { name: 'Reputation' }, { name: 'Profiles' }],
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
          {
            name: 'expand',
            in: 'query',
            schema: { type: 'string', enum: ['parties'] },
            description: 'Set to `parties` to embed clientProfile and freelancerProfile on each contract',
          },
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
    '/api/v1/profiles': {
      get: {
        tags: ['Profiles'],
        summary: 'Search profiles by skill',
        description: 'Returns profiles that include the given skill, sorted by reputation average descending.',
        parameters: [
          { name: 'skill', in: 'query', required: true, schema: { type: 'string' }, description: 'Lowercase skill slug' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque pagination cursor' },
        ],
        responses: {
          200: {
            description: 'Matching profiles',
            content: json({
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/ProfileWithReputation' } },
                nextCursor: { type: 'string', nullable: true },
              },
            }),
          },
          400: { description: 'invalid_skill or invalid_limit', content: json({ $ref: '#/components/schemas/Error' }) },
        },
      },
    },
    '/api/v1/profiles/{address}': {
      get: {
        tags: ['Profiles'],
        summary: 'Get a profile with embedded reputation',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Profile', content: json({ $ref: '#/components/schemas/ProfileWithReputation' }) },
          400: { description: 'invalid_address', content: json({ $ref: '#/components/schemas/Error' }) },
          404: { description: 'profile_not_found', content: json({ $ref: '#/components/schemas/Error' }) },
        },
      },
      put: {
        tags: ['Profiles'],
        summary: 'Create or update a profile (signature verified)',
        description:
          'The signature must be a base64 ed25519 signature by the key for `address` over ' +
          '`talenttrust-profile:v1:<address>:<nonce>:<sha256(canonicalJSON(profile))>`. ' +
          '`nonce` must be strictly greater than the stored nonce.',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['profile', 'nonce', 'signature'],
            properties: {
              profile: { $ref: '#/components/schemas/ProfileInput' },
              nonce: { type: 'integer', minimum: 1 },
              signature: { type: 'string', format: 'byte', description: 'Base64 ed25519 signature' },
            },
          }),
        },
        responses: {
          200: { description: 'Updated profile', content: json({ $ref: '#/components/schemas/ProfileWithReputation' }) },
          400: { description: 'invalid_address or invalid_profile', content: json({ $ref: '#/components/schemas/Error' }) },
          401: { description: 'invalid_signature', content: json({ $ref: '#/components/schemas/Error' }) },
          409: { description: 'stale_nonce', content: json({ $ref: '#/components/schemas/Error' }) },
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
          clientProfile: { $ref: '#/components/schemas/ProfileWithReputation' },
          freelancerProfile: { $ref: '#/components/schemas/ProfileWithReputation' },
        },
      },
      ProfileInput: {
        type: 'object',
        required: ['displayName', 'skills'],
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 60 },
          bio: { type: 'string', maxLength: 1000 },
          skills: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', maxLength: 30, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
          },
          links: {
            type: 'object',
            properties: {
              website: { type: 'string', format: 'uri', pattern: '^https://' },
              github: { type: 'string', format: 'uri', pattern: '^https://' },
            },
          },
        },
      },
      Profile: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          displayName: { type: 'string' },
          bio: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'object',
            properties: { website: { type: 'string' }, github: { type: 'string' } },
          },
          updatedAt: { type: 'string', format: 'date-time' },
          nonce: { type: 'integer' },
        },
      },
      ProfileWithReputation: {
        allOf: [
          { $ref: '#/components/schemas/Profile' },
          {
            type: 'object',
            properties: {
              reputation: {
                type: 'object',
                nullable: true,
                properties: {
                  address: { type: 'string' },
                  count: { type: 'integer' },
                  total: { type: 'integer' },
                  average: { type: 'number' },
                },
              },
            },
          },
        ],
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
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
    <div class="tt-bar"><strong>TalentTrust API</strong><a href="/openapi.json">OpenAPI json</a></div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        window.swaggerUI = SwaggerUIBundle({
          url: '/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
        });
      };
    </script>
  </body>
  </html>`;
