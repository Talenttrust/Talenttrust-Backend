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
  payload_too_large: { status: 413, title: 'Payload too large', detail: 'Request body exceeds BODY_LIMIT' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type', detail: 'Content-Type must be application/json (UTF-8, identity/gzip/deflate)' },
  invalid_body: { status: 400, title: 'Invalid body', detail: 'Request body must be a JSON object' },
  request_aborted: { status: 400, title: 'Request aborted', detail: 'Request was aborted before the body was fully received' },
  bad_request: { status: 400, title: 'Bad request', detail: 'The request could not be processed' },
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
  // Admin dispute queue
  admin_not_configured: { status: 404, title: 'Admin not configured', detail: 'Admin endpoints are disabled until ADMIN_READ_TOKEN is set' },
  dispute_not_found: { status: 404, title: 'Dispute not found', detail: 'The contract has never had a dispute' },
  invalid_status: { status: 400, title: 'Invalid status filter', detail: "status must be one of 'open', 'resolved', 'all'" },
  invalid_sort: { status: 400, title: 'Invalid sort', detail: "sort must be one of 'oldest', 'newest', 'value'" },
  invalid_overdue: { status: 400, title: 'Invalid overdue filter', detail: "overdue must be 'true' or 'false'" },
  invalid_limit: { status: 400, title: 'Invalid limit', detail: 'limit must be an integer between 1 and 100' },
  invalid_min_completed: { status: 400, title: 'Invalid minCompleted', detail: 'minCompleted must be a non-negative integer' },
  // Signed transaction relay
  invalid_transaction: { status: 400, title: 'Invalid transaction', detail: 'The signed XDR is not a valid escrow contract call for this deployment' },
  submission_failed: { status: 422, title: 'Submission failed', detail: 'Soroban RPC rejected the transaction' },
  try_again_later: { status: 503, title: 'Try again later', detail: 'Soroban RPC is busy; retry after Retry-After seconds' },
  rpc_error: { status: 502, title: 'RPC error', detail: 'Unexpected response from Soroban RPC' },
  invalid_hash: { status: 400, title: 'Invalid hash', detail: 'Transaction hash must be a 64-character hex string' },
  too_many_waits: { status: 503, title: 'Too many waits', detail: 'Too many concurrent long-poll requests' },
  // On-chain read-through
  invalid_chain_id: { status: 400, title: 'Invalid chain id', detail: 'chainId must be a positive u64' },
  chain_error: { status: 502, title: 'Chain error', detail: 'On-chain read failed' },
  chain_rate_limited: { status: 429, title: 'Chain reads rate limited', detail: 'Too many chain read requests (60 per minute per client)' },
  method_not_allowed: { status: 405, title: 'Method not allowed', detail: 'The path exists but does not support this HTTP method (see Allow)' },
  indexer_busy: { status: 409, title: 'Indexer busy', detail: 'The event indexer is already running' },
  insufficient_scope: { status: 403, title: 'Insufficient scope', detail: 'The API key does not have the required scope' },
  invalid_range: { status: 400, title: 'Invalid range', detail: 'from/to must be valid ISO dates, from before to, at most 3 years apart' },
  invalid_role: { status: 400, title: 'Invalid role', detail: 'role must be client, freelancer, or all' },
  invalid_actor: { status: 400, title: 'Invalid actor', detail: 'as must be a single non-empty address string' },
  origin_not_allowed: { status: 403, title: 'Origin not allowed', detail: 'Origin is not allowed by CORS policy' },
  // On-chain pause
  contract_paused: {
    status: 503,
    title: 'Contract paused',
    detail: 'Contract mutations are currently paused',
    contractError: { name: 'Paused', code: 4 },
  },
  // Concurrency / receipts
  precondition_failed: { status: 412, title: 'Precondition failed', detail: 'If-Match does not match the current ETag' },
  precondition_required: { status: 428, title: 'Precondition required', detail: 'If-Match header is required' },
  invalid_receipt: { status: 400, title: 'Invalid receipt', detail: 'receipt must be a non-empty JWS string' },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorKey = keyof typeof ERRORS;

export const PROBLEM_TYPE_BASE = 'https://talenttrust-backend.vercel.app/errors';

export const isErrorKey = (code: string): code is ErrorKey => Object.prototype.hasOwnProperty.call(ERRORS, code);
