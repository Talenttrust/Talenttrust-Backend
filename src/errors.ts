export interface ErrorEntry {
  status: number;
  title: string;
  detail?: string;
  contractError?: { name: string; code: number };
  legacyCode?: string;
}

export const ERRORS = {
  invalid_id: { status: 400, title: 'Invalid ID', detail: 'id must be a positive integer' },
  contract_not_found: { status: 404, title: 'Contract not found', detail: 'Contract not found' },
  invalid_parties: { status: 400, title: 'Invalid parties', detail: 'client and freelancer are required strings' },
  invalid_milestones: { status: 400, title: 'Invalid milestones', detail: 'milestones must be a non-empty array' },
  invalid_amount: { status: 400, title: 'Invalid amount', detail: 'amount must be positive' },
  over_funded: { status: 409, title: 'Over funded', detail: 'deposit exceeds contract total', contractError: { name: 'OverFunded', code: 9 } },
  milestone_not_found: { status: 404, title: 'Milestone not found', detail: 'Milestone not found' },
  already_released: { status: 409, title: 'Already released', detail: 'Milestone already released' },
  insufficient_funds: { status: 409, title: 'Insufficient funds', detail: 'Escrow balance too low for this milestone' },
  forbidden: { status: 403, title: 'Forbidden', detail: 'Only the client or freelancer can open a dispute', legacyCode: 'unauthorized' },
  contract_not_active: { status: 409, title: 'Contract not active', detail: 'Contract is not active' },
  contract_not_disputed: { status: 409, title: 'Contract not disputed', detail: 'Contract is not disputed' },
  contract_not_completed: { status: 409, title: 'Contract not completed', detail: 'Only completed contracts can be rated' },
  invalid_split: { status: 400, title: 'Invalid split', detail: 'freelancerBps must be an integer 0..10000' },
  already_rated: { status: 409, title: 'Already rated', detail: 'Reputation already issued for this contract' },
  invalid_rating: { status: 400, title: 'Invalid rating', detail: 'rating must be an integer 1..5' },
  not_found: { status: 404, title: 'Not found', detail: 'No route found' },
  invalid_json: { status: 400, title: 'Invalid JSON', detail: 'Malformed JSON body' },
  internal_error: { status: 500, title: 'Internal error', detail: 'Unexpected error' },
  invalid_escrow_id: { status: 400, title: 'Invalid escrow ID', detail: 'escrowId must be a non-empty string' },
  already_linked: { status: 409, title: 'Already linked', detail: 'Contract is already linked to on-chain escrow' },
  chain_escrow_taken: { status: 409, title: 'Chain escrow taken', detail: 'On-chain escrow is already linked to another contract' },
  chain_unavailable: { status: 503, title: 'Chain unavailable', detail: 'Chain RPC service unavailable' },
  chain_contract_not_found: { status: 404, title: 'Chain contract not found', detail: 'On-chain escrow not found' },
  chain_mismatch: { status: 409, title: 'Chain mismatch', detail: 'API contract does not match on-chain escrow parameters' },
  not_linked: { status: 409, title: 'Not linked', detail: 'Contract is not linked to any on-chain escrow' },
} as const;

export type ErrorKey = keyof typeof ERRORS;

const PROBLEM_TYPE_BASE = 'https://talenttrust-backend.vercel.app/errors';

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly type: string;
  public readonly contractError?: { name: string; code: number };
  public readonly legacyCode?: string;
  public readonly details?: Record<string, unknown>;

  constructor(public key: ErrorKey, message?: string, details?: Record<string, unknown>) {
    const entry = ERRORS[key];
    super(message ?? entry.detail);
    this.status = entry.status;
    this.code = key;
    this.type = `${PROBLEM_TYPE_BASE}/${key}`;
    this.contractError = 'contractError' in entry ? entry.contractError : undefined;
    this.legacyCode = 'legacyCode' in entry ? entry.legacyCode : undefined;
    this.details = details;
    Object.setPrototypeOf(this, HttpError.prototype);
  }

  toProblemBody(message?: string) {
    const entry = ERRORS[this.key];
    const detail = message ?? entry.detail;
    const body: Record<string, unknown> = {
      type: this.type,
      title: entry.title,
      status: this.status,
      detail,
      error: this.code,
      message: detail,
    };
    if (this.contractError) {
      body.contractError = this.contractError;
    }
    if (this.details) {
      Object.assign(body, this.details);
    }
    return body;
  }
}
