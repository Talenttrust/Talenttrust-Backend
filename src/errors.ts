/**
 * Typed error catalog. Every error code the API returns is listed here with its
 * HTTP status and a human title, and is served as an RFC 9457
 * `application/problem+json` body whose `type` is `${PROBLEM_TYPE_BASE}/<code>`.
 * `error` and `message` stay in every body for existing clients.
 *
 * This module has no imports so `amount-error.ts` (HttpError) can depend on it.
 */

export interface ErrorEntry {
  status: number;
  title: string;
  detail: string;
  contractError?: { name: string; code: number };
  /** Previous code for the same condition, kept for client migration notes. */
  legacyCode?: string;
}

export const ERRORS = {
  // Generic
  not_found: { status: 404, title: 'Not found', detail: 'No route found' },
  invalid_json: { status: 400, title: 'Invalid JSON', detail: 'Malformed JSON body' },
  internal_error: { status: 500, title: 'Internal error', detail: 'Unexpected error' },
  validation_failed: { status: 400, title: 'Validation failed', detail: 'The request did not match the expected schema' },
  invalid_query: { status: 400, title: 'Invalid query', detail: 'A query parameter is invalid' },
  invalid_cursor: { status: 400, title: 'Invalid cursor', detail: 'The pagination cursor is invalid or was issued for another sort' },
  invalid_fields: { status: 400, title: 'Invalid fields', detail: 'The ?fields= selection names an unknown field' },
  // Contracts
  invalid_id: { status: 400, title: 'Invalid ID', detail: 'id must be a positive integer' },
  contract_not_found: { status: 404, title: 'Contract not found', detail: 'Contract not found' },
  invalid_parties: { status: 400, title: 'Invalid parties', detail: 'client and freelancer are required, distinct strings' },
  invalid_milestones: { status: 400, title: 'Invalid milestones', detail: 'milestones must be a non-empty array of at most 20 items' },
  invalid_amount: { status: 400, title: 'Invalid amount', detail: 'amount must be a positive integer in token base units' },
  over_funded: {
    status: 409,
    title: 'Over funded',
    detail: 'deposit exceeds contract total',
    contractError: { name: 'OverFunded', code: 9 },
  },
  milestone_not_found: { status: 404, title: 'Milestone not found', detail: 'Milestone not found' },
  already_released: { status: 409, title: 'Already released', detail: 'Milestone already released' },
  insufficient_funds: { status: 409, title: 'Insufficient funds', detail: 'Escrow balance too low for this milestone' },
  forbidden: {
    status: 403,
    title: 'Forbidden',
    detail: 'The caller is not the party allowed to perform this action',
    legacyCode: 'unauthorized',
  },
  contract_not_active: { status: 409, title: 'Contract not active', detail: 'Contract is not active', legacyCode: 'invalid_status' },
  contract_not_disputed: { status: 409, title: 'Contract not disputed', detail: 'Contract is not disputed', legacyCode: 'invalid_status' },
  contract_not_completed: {
    status: 409,
    title: 'Contract not completed',
    detail: 'Only completed (or resolved, for reviews) contracts can be rated',
    legacyCode: 'invalid_status',
  },
  invalid_split: { status: 400, title: 'Invalid split', detail: 'freelancerBps must be an integer 0..10000' },
  reputation_already_issued: { status: 409, title: 'Reputation already issued', detail: 'Reputation already issued for this contract' },
  invalid_rating: { status: 400, title: 'Invalid rating', detail: 'rating must be an integer 1..5' },
  empty_patch: { status: 400, title: 'Empty patch', detail: 'At least one of title or milestones must be provided' },
  contract_locked: { status: 409, title: 'Contract locked', detail: 'Contract terms can only be changed before funding' },
  invalid_deadline: { status: 400, title: 'Invalid deadline', detail: 'fundingDeadline must be 1 hour to 90 days in the future' },
  contract_expired: { status: 409, title: 'Contract expired', detail: 'Contract funding deadline has passed' },
  // Reviews
  invalid_comment: { status: 400, title: 'Invalid comment', detail: 'comment must be a string of at most 1000 characters without control characters' },
  already_reviewed: { status: 409, title: 'Already reviewed', detail: 'Review already submitted for this direction' },
  // Chain link / parity
  invalid_escrow_id: { status: 400, title: 'Invalid escrow ID', detail: 'escrowId must be a non-empty string' },
  already_linked: { status: 409, title: 'Already linked', detail: 'Contract is already linked to on-chain escrow' },
  chain_escrow_taken: { status: 409, title: 'Chain escrow taken', detail: 'On-chain escrow is already linked to another contract' },
  chain_unavailable: { status: 503, title: 'Chain unavailable', detail: 'Chain RPC service unavailable' },
  chain_contract_not_found: { status: 404, title: 'Chain contract not found', detail: 'On-chain escrow not found' },
  chain_mismatch: { status: 409, title: 'Chain mismatch', detail: 'API contract does not match on-chain escrow parameters' },
  not_linked: { status: 409, title: 'Not linked', detail: 'Contract is not linked to any on-chain escrow' },
  // Idempotency
  idempotency_key_required: { status: 400, title: 'Idempotency key required', detail: 'Idempotency-Key header is required on POST' },
  invalid_idempotency_key: { status: 400, title: 'Invalid idempotency key', detail: 'Idempotency-Key must be 1-255 printable ASCII characters' },
  idempotency_request_in_progress: { status: 409, title: 'Request in progress', detail: 'A request with this Idempotency-Key is still in progress' },
  idempotency_key_reused: { status: 422, title: 'Idempotency key reused', detail: 'Idempotency-Key was already used with a different request body' },
  // Auth
  unauthorized: { status: 401, title: 'Unauthorized', detail: 'Missing, malformed, invalid or expired bearer token' },
  invalid_address: { status: 400, title: 'Invalid address', detail: 'address must be a valid Stellar G… public key' },
  invalid_challenge: { status: 401, title: 'Invalid challenge', detail: 'Challenge is missing, tampered with, or for another address' },
  challenge_expired: { status: 401, title: 'Challenge expired', detail: 'Challenge has expired' },
  challenge_replayed: { status: 401, title: 'Challenge replayed', detail: 'Challenge has already been used' },
  invalid_signature: { status: 401, title: 'Invalid signature', detail: 'Signature is missing or does not verify' },
  cron_unauthorized: { status: 401, title: 'Cron unauthorized', detail: 'Valid bearer authorization is required' },
  // Concurrency / receipts
  precondition_failed: { status: 412, title: 'Precondition failed', detail: 'If-Match does not match the current ETag' },
  precondition_required: { status: 428, title: 'Precondition required', detail: 'If-Match header is required' },
  invalid_receipt: { status: 400, title: 'Invalid receipt', detail: 'receipt must be a non-empty JWS string' },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorKey = keyof typeof ERRORS;

export const PROBLEM_TYPE_BASE = 'https://talenttrust-backend.vercel.app/errors';

export const isErrorKey = (code: string): code is ErrorKey => Object.prototype.hasOwnProperty.call(ERRORS, code);
