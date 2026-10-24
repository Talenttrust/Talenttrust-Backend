import { config, explorerUrl } from './config';
import { ALLOWED_FIELDS } from './utils/project';

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object = { type: 'object' }) => ({
  200: { description, content: json(schema) },
});
const errorResponse = (description: string, schema: object = { $ref: '#/components/schemas/ErrorResponse' }) => ({
  description,
  content: json(schema),
});
const created = (description: string, schema: object = { type: 'object' }) => ({
  201: { description, content: json(schema) },
});

const validationErrorResponse = {
  400: {
    description: 'Validation failed',
    content: json({ $ref: '#/components/schemas/ValidationError' }),
  },
};

const errorResponses = {
  400: {
    description: 'Validation failed',
    content: json({ $ref: '#/components/schemas/ValidationError' }),
  },
  403: {
    description: 'Forbidden',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  404: {
    description: 'Not found',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  409: {
    description: 'Conflict',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
  500: {
    description: 'Internal error',
    content: json({ $ref: '#/components/schemas/ErrorResponse' }),
  },
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
  description: 'Contract ID (positive integer)',
};
const indexParam = {
  name: 'index',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^(?:[0-9]|1[0-9])$' },
  description: 'Milestone index (0-19)',
};
const addressParam = {
  name: 'address',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
  description: 'Stellar address',
};
const contractRef = { $ref: '#/components/schemas/EscrowContract' };
const reviewRef = { $ref: '#/components/schemas/Review' };
const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
const reputationRef = { $ref: '#/components/schemas/Reputation' };

/**
 * `?fields=` query parameter shared by GET /contracts and GET /contracts/:id.
 * Clients may request a subset of EscrowContract fields to reduce payload
 * size.  `id` is always returned.  Use dot notation for milestone sub-fields
 * (e.g. `milestones.amount`).  Unknown fields yield a 400 error.
 */
const fieldsParam = {
  name: 'fields',
  in: 'query',
  required: false,
  description:
    'Comma-separated list of fields to include in the response. ' +
    '`id` is always returned. Use `milestones.amount` style notation for ' +
    'nested milestone fields. Unknown fields return 400. ' +
    `Allowed values: ${ALLOWED_FIELDS.join(', ')}.`,
  schema: {
    type: 'string',
    example: 'title,status,totalAmount',
  },
};

const fieldsError = {
  400: {
    description: 'Invalid `?fields=` value. The response body lists valid field names.',
    content: json(errorRef),
  },
};

const amountSchema = {
  oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]{0,37}$' }],
  description: 'Amount in token base units. Must be a positive integer.',
};
const milestonesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: {
    oneOf: [
      amountSchema,
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          amount: amountSchema,
        },
        required: ['amount'],
      },
    ],
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'TalentTrust API',
    version: config.version,
    description:
      'Milestone-based escrow API for freelancers and clients. State mirrors the TalentTrust ' +
      `Soroban escrow contract on Stellar ${config.network} (${config.contractId}). ` +
      `Explorer: ${explorerUrl()}. Data is held in memory and resets on redeploy.\n\n` +
      '**Response compression**: The API compresses JSON responses ≥ 1 KB with gzip or Brotli ' +
      'when the client sends an `Accept-Encoding` header. A `Vary: Accept-Encoding` header is ' +
      'included on compressed responses.\n\n' +
      '**Sparse fieldsets**: GET /contracts and GET /contracts/:id accept a `?fields=` query ' +
      'parameter so clients can download only the fields they need.\n\n' +
      '**Authentication**: mutating routes accept a bearer token obtained via the auth endpoints. ' +
      'Call `GET /api/v1/auth/challenge?address=G…`, sign the returned challenge string with your ' +
      'Stellar ed25519 private key, then `POST /api/v1/auth/token` to receive a short-lived JWT. ' +
      'Tokens are required when the server runs with `AUTH_SECRET` set (or `AUTH_REQUIRED=true`).',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'System' },
    { name: 'Auth', description: 'Wallet-signature authentication (SEP-10 style)' },
    { name: 'Contracts' },
    { name: 'Reputation' },
    { name: 'Transaction' },
  ],
  paths: {
    '/api/v1/auth/challenge': {
      get: {
        tags: ['Auth'],
        summary: 'Request a sign challenge for a Stellar address',
        description:
          'Returns a short-lived HMAC-signed challenge string. ' +
          'Sign it with the ed25519 private key corresponding to `address` and pass it to `POST /api/v1/auth/token`.',
        parameters: [
          {
            name: 'address',
            in: 'query',
            required: true,
            description: 'Stellar G… ed25519 public key.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          ...ok('Challenge issued.', { $ref: '#/components/schemas/ChallengeResponse' }),
          400: errorResponse('Invalid Stellar address (invalid_address).'),
        },
      },
    },
    '/api/v1/auth/token': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange a signed challenge for a bearer token',
        description:
          'Verifies the HMAC, challenge expiry, address match, and ed25519 signature. ' +
          'Returns an HS256 JWT (≤ 1 h) to use as `Authorization: Bearer <token>` on protected routes.',
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/TokenRequest' }) },
        responses: {
          ...ok('Token issued.', { $ref: '#/components/schemas/TokenResponse' }),
          401: errorResponse('invalid_challenge / challenge_expired / challenge_replayed / invalid_signature.'),
        },
      },
    },
    '/health': { get: { tags: ['System'], summary: 'Health check', responses: ok('Service is healthy') } },
    '/api/v1/chain': {
      get: { tags: ['System'], summary: 'On-chain escrow contract deployment info', responses: ok('Deployment') },
    },
    '/api/v1/stats': { get: { tags: ['System'], summary: 'Aggregate escrow statistics', responses: ok('Stats', { type: 'object', properties: { contracts: { type: 'integer' }, byStatus: { type: 'object' }, totalEscrowed: { description: 'DEPRECATED — lossy above 2^53. Use totalEscrowedUnits.', oneOf: [{ type: 'number' }] }, totalEscrowedUnits: { type: 'string', description: 'Total escrowed in token base units (bigint-safe decimal string).' }, totalReleased: { description: 'DEPRECATED — lossy above 2^53. Use totalReleasedUnits.', oneOf: [{ type: 'number' }] }, totalReleasedUnits: { type: 'string', description: 'Total released in token base units (bigint-safe decimal string).' } } }) } },
    '/api/v1/tx/build': {
      post: {
        tags: ['Transaction'],
        summary: 'Build a simulated, unsigned Soroban transaction for an escrow action',
        description:
          'Assembles an unsigned invokeHostFunction transaction against the configured escrow contract, ' +
          'simulates it via Soroban RPC, and returns the assembled XDR ready for a wallet (Freighter, xBull, …) ' +
          'to sign. The server never holds or requires user secret keys. `source` must be the Stellar account ' +
          'that the contract will `require_auth` (client for create/deposit/release/cancel/issue_reputation, ' +
          'caller for open_dispute). `resolve_dispute` and `set_paused` are admin-only and not buildable.',
        requestBody: {
          required: true,
          content: json({ $ref: '#/components/schemas/TxBuildRequest' }),
        },
        responses: {
          200: { description: 'Simulated, assembled unsigned transaction', content: json({ $ref: '#/components/schemas/TxBuildResponse' }) },
          400: errorResponse('Invalid action, source, or args; or source does not match the party the contract will require_auth (source_mismatch)', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          403: errorResponse('Admin-only action (resolve_dispute, set_paused) is not buildable', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          404: errorResponse('Source account not found on chain', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          422: errorResponse('Contract simulation failed (contract_error)', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
          503: errorResponse('Stellar RPC unavailable', {
            $ref: '#/components/schemas/TxBuildErrorResponse',
          }),
        },
      },
    },
    '/api/v1/contracts': {
      get: {
        tags: ['Contracts'],
        summary: 'List escrow contracts',
        description:
          'Returns an array of contracts. Supports filtering by `status` or `party` address. ' +
          'Use `?fields=` to request a sparse response — only the listed fields are included, ' +
          'reducing payload size for list views.',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] } },
          { name: 'party', in: 'query', schema: { type: 'string', maxLength: 64 }, description: 'Client or freelancer address' },
          fieldsParam,
          { name: 'linked', in: 'query', schema: { type: 'boolean' }, description: 'Filter by whether contract is linked to on-chain escrow' },
        ],
        responses: {
          ...ok('Contracts', { type: 'object', properties: { data: { type: 'array', items: contractRef } } }),
          ...fieldsError,
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
              milestones: milestonesSchema,
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(contractRef) },
          400: errorResponse('Invalid contract input'),
        },
      },
    },
    '/api/v1/contracts/{id}': {
      get: {
        tags: ['Contracts'],
        summary: 'Get a contract',
        description:
          'Returns a single contract by numeric ID. ' +
          'Use `?fields=` to request only a subset of fields.',
        parameters: [idParam, fieldsParam],
        responses: {
          ...ok('Contract', contractRef),
          400: errorResponse('Invalid contract id or invalid `?fields=` value'),
          404: errorResponse('Contract not found'),
        },
      },
      patch: {
        tags: ['Contracts'],
        summary: 'Edit an unfunded contract',
        description: 'Only the matching client can edit a contract while it is Created and has received no funds.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client'],
            minProperties: 2,
            properties: {
              client: { type: 'string' },
              title: { type: 'string' },
              milestones: milestonesSchema,
            },
          }),
        },
        responses: {
          ...ok('Updated contract', contractRef),
          400: errorResponse('Empty patch, invalid contract id, or invalid milestones'),
          403: errorResponse('Client does not own the contract'),
          404: errorResponse('Contract not found'),
          409: errorResponse('Contract is funded or no longer editable'),
        },
      },
      delete: {
        tags: ['Contracts'],
        summary: 'Withdraw an unfunded contract',
        description: 'Only the matching client can withdraw a contract while it is Created and has received no funds.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['client'],
            properties: { client: { type: 'string' } },
          }),
        },
        responses: {
          204: { description: 'Contract withdrawn' },
          400: errorResponse('Invalid contract id'),
          403: errorResponse('Client does not own the contract'),
          404: errorResponse('Contract not found'),
          409: errorResponse('Contract is funded or no longer withdrawable'),
        },
      },
    },
    '/api/v1/contracts/{id}/revisions': {
      get: {
        tags: ['Contracts'],
        summary: 'Get contract term revision history',
        parameters: [idParam],
        responses: {
          ...ok('Revision history', {
            type: 'array',
            items: { $ref: '#/components/schemas/ContractRevision' },
          }),
          400: errorResponse('Invalid contract id'),
          404: errorResponse('Contract not found'),
        },
      },
    },
    '/api/v1/contracts/{id}/deposit': {
      post: {
        tags: ['Contracts'],
        summary: 'Deposit funds into escrow',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { amount: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]{0,37}$', description: 'Positive decimal integer string' }], description: 'Deposit amount in token base units (e.g. stroops). Must be a positive integer.' } } }) },
        responses: ok('Updated contract', contractRef),
      },
    },
    '/api/v1/contracts/{id}/milestones/{index}/release': {
      post: {
        tags: ['Contracts'],
        summary: 'Release a milestone payment to the freelancer',
        parameters: [idParam, indexParam],
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/dispute': {
      post: {
        tags: ['Contracts'],
        summary: 'Open a dispute',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/DisputeRequest' }) },
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/resolve': {
      post: {
        tags: ['Contracts'],
        summary: 'Resolve a dispute',
        parameters: [idParam],
        requestBody: { required: true, content: json({ $ref: '#/components/schemas/ResolveRequest' }) },
        responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses },
      },
    },
    '/api/v1/contracts/{id}/cancel': {
      post: { tags: ['Contracts'], summary: 'Cancel and refund', parameters: [idParam], responses: { 200: { description: 'Updated contract', content: json(contractRef) }, ...errorResponses } },
    },
    '/api/v1/contracts/{id}/reputation': {
      post: {
        tags: ['Reputation'],
        summary: 'Rate the freelancer of a completed contract',
        description:
          'Backward-compatible endpoint. Creates a client-to-freelancer review without a comment ' +
          'and sets the contract reputationIssued flag.',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } }) },
        responses: {
          ...ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
          400: { description: 'invalid_rating', content: json(errorRef) },
          409: { description: 'already_rated or invalid_status', content: json(errorRef) },
        },
      },
    },
    '/api/v1/contracts/{id}/reviews': {
      post: {
        tags: ['Reputation'],
        summary: 'Create a review for a contract (client or freelancer)',
        description:
          'One review per direction per contract. The reviewer must be a party to the contract, ' +
          'the contract must be Completed or Resolved. Reviews of Resolved contracts carry ' +
          "context: 'disputed'.",
        parameters: [idParam],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['reviewer', 'rating'],
            properties: {
              reviewer: { type: 'string', description: 'Client or freelancer address of the contract' },
              rating: { type: 'integer', minimum: 1, maximum: 5 },
              comment: { type: 'string', maxLength: 1000, description: 'Trimmed; control characters rejected' },
            },
          }),
        },
        responses: {
          201: { description: 'Created', content: json(reviewRef) },
          400: { description: 'invalid_rating or invalid_comment', content: json(errorRef) },
          403: { description: 'forbidden', content: json(errorRef) },
          404: { description: 'not_found', content: json(errorRef) },
          409: { description: 'invalid_status or already_reviewed', content: json(errorRef) },
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
        summary: 'Get reputation for an address (freelancer and client)',
        parameters: [addressParam],
        responses: ok('Reputation', { $ref: '#/components/schemas/Reputation' }),
      },
    },
    '/api/v1/reputation/{address}/reviews': {
      get: {
        tags: ['Reputation'],
        summary: 'List reviews received by an address, newest first',
        parameters: [
          addressParam,
          {
            name: 'role',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['client_to_freelancer', 'freelancer_to_client'] },
            description: 'Filter by review direction',
          },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'integer' }, description: 'Pagination cursor (the previous page nextCursor)' },
        ],
        responses: ok('Reviews', {
          type: 'object',
          properties: {
            reviews: { type: 'array', items: reviewRef },
            nextCursor: { type: 'integer', nullable: true },
          },
        }),
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'HS256 JWT obtained via POST /api/v1/auth/token after signing a challenge.',
      },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          '1-255 printable ASCII characters. Retrying a POST with the same key and body replays the stored ' +
          'response with `Idempotent-Replayed: true` instead of applying it twice. Responses with status >= 500 ' +
          'are not stored. Keys are kept for 24h and scoped by method, path and authenticated principal ' +
          '(if any). Required when the server runs with IDEMPOTENCY_REQUIRED=true.',
        schema: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x20-\\x7e]+$' },
      },
    },
    responses: {
      InvalidIdempotencyKey: {
        description: 'Idempotency-Key is malformed (`invalid_idempotency_key`) or missing while required (`idempotency_key_required`)',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      IdempotencyConflict: {
        description:
          '`idempotency_request_in_progress`: a request with this key is still running (see `Retry-After`). ' +
          'Other 409 codes are business-rule conflicts such as `over_funded`.',
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying' } },
        content: json({ $ref: '#/components/schemas/Error' }),
      },
      IdempotencyKeyReused: {
        description: '`idempotency_key_reused`: the key was already used with a different request body',
        content: json({ $ref: '#/components/schemas/Error' }),
      },
    },
    schemas: {
      ChallengeResponse: {
        type: 'object',
        required: ['address', 'challenge', 'expiresAt'],
        properties: {
          address: { type: 'string' },
          challenge: { type: 'string', description: 'Sign these exact UTF-8 bytes with the wallet key.' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      TokenRequest: {
        type: 'object',
        required: ['address', 'challenge', 'signature'],
        properties: {
          address: { type: 'string' },
          challenge: { type: 'string' },
          signature: { type: 'string', description: 'Base64 ed25519 signature over the challenge string.' },
        },
      },
      TokenResponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
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
      Review: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          contractId: { type: 'integer' },
          reviewer: { type: 'string' },
          reviewee: { type: 'string' },
          role: { type: 'string', enum: ['client_to_freelancer', 'freelancer_to_client'] },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 1000 },
          context: { type: 'string', enum: ['disputed'], description: 'Present only for reviews of Resolved contracts' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Reputation: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          completedContracts: { type: 'integer' },
          totalRating: { type: 'integer' },
          averageRating: { type: 'number' },
          asClient: {
            type: 'object',
            properties: {
              completedContracts: { type: 'integer' },
              averageRating: { type: 'number' },
            },
          },
        },
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
      Error: {
        type: 'object',
        properties: { error: { type: 'string' }, message: { type: 'string' } },
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
                amount: {
                  description: 'DEPRECATED — lossy above 2^53. Use amountUnits.',
                  oneOf: [{ type: 'number' }, { type: 'string' }],
                },
                amountUnits: {
                  type: 'string',
                  description: 'Canonical decimal string amount in token base units (e.g. stroops).',
                },
                released: { type: 'boolean' },
              },
            },
          },
          totalAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use totalAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          totalAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string total in token base units.',
          },
          fundedAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use fundedAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          fundedAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string funded amount in token base units.',
          },
          releasedAmount: {
            description: 'DEPRECATED — lossy above 2^53. Use releasedAmountUnits.',
            oneOf: [{ type: 'number' }, { type: 'string' }],
          },
          releasedAmountUnits: {
            type: 'string',
            description: 'Canonical decimal string released amount in token base units.',
          },
          status: { type: 'string', enum: ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'] },
          reputationIssued: { type: 'boolean' },
          dispute: {
            type: 'object',
            nullable: true,
            properties: {
              raisedBy: { type: 'string' },
              reason: { type: 'string' },
              openedAt: { type: 'string', format: 'date-time' },
              freelancerBps: { type: 'integer' },
              resolvedAt: { type: 'string', format: 'date-time' },
            },
          },
          chain: { $ref: '#/components/schemas/ChainInfo' },
          revision: { type: 'integer', minimum: 1, description: 'Term revision; increments on every edit.' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      TxBuildRequest: {
        type: 'object',
        required: ['action', 'source', 'args'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_contract',
              'deposit_funds',
              'release_milestone',
              'open_dispute',
              'cancel_contract',
              'issue_reputation',
            ],
          },
          source: { type: 'string', description: 'Stellar account (G…) that will sign the transaction' },
          args: {
            oneOf: [
              {
                type: 'object',
                description: 'create_contract',
                required: ['client', 'freelancer', 'token', 'milestoneAmounts'],
                properties: {
                  client: { type: 'string', description: 'Stellar address' },
                  freelancer: { type: 'string', description: 'Stellar address' },
                  token: { type: 'string', description: 'Stellar asset/token address' },
                  milestoneAmounts: {
                    type: 'array',
                    items: { type: 'string', description: 'decimal string within i128 range' },
                    minItems: 1,
                    maxItems: 20,
                  },
                },
              },
              {
                type: 'object',
                description: 'deposit_funds',
                required: ['id', 'amount'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  amount: { type: 'string', description: 'decimal string within i128 range' },
                },
              },
              {
                type: 'object',
                description: 'release_milestone',
                required: ['id', 'index'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  index: { type: 'integer', minimum: 0, description: 'u32 milestone index' },
                },
              },
              {
                type: 'object',
                description: 'open_dispute',
                required: ['id', 'caller'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  caller: { type: 'string', description: 'Stellar address opening the dispute' },
                },
              },
              {
                type: 'object',
                description: 'cancel_contract',
                required: ['id'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                },
              },
              {
                type: 'object',
                description: 'issue_reputation',
                required: ['id', 'rating'],
                properties: {
                  id: { type: 'string', description: 'u64 escrow id as decimal string' },
                  rating: { type: 'integer', minimum: 0, description: 'u32 reputation rating' },
                },
              },
            ],
          },
        },
      },
      TxBuildResponse: {
        type: 'object',
        properties: {
          xdr: { type: 'string', description: 'Base64 unsigned transaction envelope XDR' },
          networkPassphrase: { type: 'string' },
          fee: {
            type: 'object',
            properties: {
              inclusion: { type: 'string', description: 'Classic inclusion fee (stroops)' },
              resource: { type: 'string', description: 'Soroban resource fee (stroops)' },
              total: { type: 'string', description: 'Total fee (stroops)' },
            },
          },
          minResourceFee: { type: 'string', description: 'Minimum resource fee from simulation (stroops)' },
          latestLedger: { type: 'integer' },
          expiresAt: { type: 'string', format: 'date-time', description: 'Approximate transaction expiry from timebounds' },
          authRequired: {
            type: 'array',
            items: { type: 'string' },
            description: 'Addresses whose Soroban auth entries the wallet must sign',
          },
        },
      },
      TxBuildErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            enum: [
              'invalid_action',
              'invalid_source',
              'invalid_args',
              'source_mismatch',
              'admin_action_not_buildable',
              'source_account_not_found',
              'contract_error',
              'simulation_failed',
              'chain_unavailable',
            ],
          },
          message: { type: 'string' },
          contractError: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              code: { type: 'integer' },
            },
            description: 'Present only for contract_error responses',
          },
          requestId: { type: 'string' },
        },
      },
      ContractRevision: {
        type: 'object',
        required: ['revision', 'at', 'changes'],
        properties: {
          revision: { type: 'integer', minimum: 2 },
          at: { type: 'string', format: 'date-time' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'from', 'to'],
              properties: {
                field: { type: 'string', enum: ['title', 'milestones'] },
                from: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
              },
            },
          },
        },
      },
      ValidationError: {
        type: 'object',
        properties: {
          error: { type: 'string', enum: ['validation_failed'] },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['path', 'message'],
            },
          },
        },
        required: ['error', 'message', 'details'],
      },
      CreateContractRequest: {
        type: 'object',
        required: ['client', 'freelancer', 'milestones'],
        properties: {
          title: { type: 'string', maxLength: 120 },
          client: { type: 'string', minLength: 1 },
          freelancer: { type: 'string', minLength: 1 },
          token: { type: 'string', maxLength: 64 },
          milestones: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              oneOf: [
                amountSchema,
                {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: 120 },
                    amount: amountSchema,
                  },
                  required: ['amount'],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
      DepositRequest: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: amountSchema,
        },
        additionalProperties: false,
      },
      DisputeRequest: {
        type: 'object',
        required: ['raisedBy'],
        properties: {
          raisedBy: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        additionalProperties: false,
      },
      ResolveRequest: {
        type: 'object',
        required: ['freelancerBps'],
        properties: {
          freelancerBps: { type: 'integer', minimum: 0, maximum: 10000 },
        },
        additionalProperties: false,
      },
      RateRequest: {
        type: 'object',
        required: ['rating'],
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  },
};

type Operation = { parameters?: object[]; responses: Record<string, object> };

/** Documents Idempotency-Key and its error statuses on every POST operation. */
function withIdempotency<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, { post?: Operation }>;
  for (const item of Object.values(paths)) {
    const op = item.post;
    if (!op) continue;
    op.parameters = [...(op.parameters ?? []), { $ref: '#/components/parameters/IdempotencyKey' }];
    op.responses = {
      ...op.responses,
      400: { $ref: '#/components/responses/InvalidIdempotencyKey' },
      409: { $ref: '#/components/responses/IdempotencyConflict' },
      422: { $ref: '#/components/responses/IdempotencyKeyReused' },
    };
  }
  return doc;
}

/** Operations that accept (and, when enabled, require) a wallet bearer token. */
const PROTECTED: Array<[string, string]> = [
  ['/api/v1/contracts', 'post'],
  ['/api/v1/contracts/{id}', 'patch'],
  ['/api/v1/contracts/{id}', 'delete'],
  ['/api/v1/contracts/{id}/deposit', 'post'],
  ['/api/v1/contracts/{id}/milestones/{index}/release', 'post'],
  ['/api/v1/contracts/{id}/dispute', 'post'],
  ['/api/v1/contracts/{id}/cancel', 'post'],
  ['/api/v1/contracts/{id}/reputation', 'post'],
  ['/api/v1/contracts/{id}/reviews', 'post'],
];

/** Adds bearerAuth security plus 401/403 responses to every protected operation. */
function withBearerAuth<T extends { paths: object }>(doc: T): T {
  const paths = doc.paths as Record<string, Record<string, (Operation & { security?: object[] }) | undefined>>;
  for (const [path, method] of PROTECTED) {
    const op = paths[path]?.[method];
    if (!op) continue;
    op.security = [{ bearerAuth: [] }];
    op.responses = {
      ...op.responses,
      401: errorResponse('Missing or invalid bearer token.'),
      403: errorResponse('Authenticated caller is not the required party for this operation.'),
    };
  }
  return doc;
}

export const openapi = withBearerAuth(withIdempotency(spec));

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
