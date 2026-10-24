/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 *
 * All monetary amounts are stored internally as bigint (token smallest-unit
 * integers) and serialised as decimal strings in *Units response fields.
 * The legacy numeric fields (totalAmount, fundedAmount, releasedAmount,
 * milestone.amount) are kept for backwards compatibility but are documented as
 * deprecated and lossy above Number.MAX_SAFE_INTEGER.
 */

import { parseAmount, checkedAdd, I128_MAX } from './amount';
import { HttpError } from './amount-error';

export { HttpError } from './amount-error';

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export interface Milestone {
  index: number;
  title: string;
  /** @deprecated lossy above 2^53; use amountUnits */
  amount: number | string;
  /** Canonical decimal-string representation of the milestone amount (base units). */
  amountUnits: string;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
}

export interface DriftItem {
  field: string;
  api: unknown;
  chain: unknown;
}

export interface ChainInfo {
  escrowId: string;
  linkedAt: string;
  lastVerifiedAt: string;
  status: 'in_sync' | 'drift' | 'unverified';
  drift: DriftItem[];
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  /** @deprecated lossy above 2^53; use totalAmountUnits */
  totalAmount: number | string;
  /** Canonical decimal-string total (base units). */
  totalAmountUnits: string;
  /** @deprecated lossy above 2^53; use fundedAmountUnits */
  fundedAmount: number | string;
  /** Canonical decimal-string funded amount (base units). */
  fundedAmountUnits: string;
  /** @deprecated lossy above 2^53; use releasedAmountUnits */
  releasedAmount: number | string;
  /** Canonical decimal-string released amount (base units). */
  releasedAmountUnits: string;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  /** Term revision number; starts at 1 and increments on every edit. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractRevision {
  revision: number;
  at: string;
  changes: Array<{ field: 'title' | 'milestones'; from: unknown; to: unknown }>;
}

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
}

export type ReviewRole = 'client_to_freelancer' | 'freelancer_to_client';

export interface Review {
  id: number;
  contractId: number;
  reviewer: string;
  reviewee: string;
  role: ReviewRole;
  rating: number;
  comment?: string;
  context?: 'disputed';
  createdAt: string;
}

/** Internal store record — keeps bigints for arithmetic. */
interface InternalContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Array<{
    index: number;
    title: string;
    amount: bigint;
    released: boolean;
  }>;
  totalAmount: bigint;
  fundedAmount: bigint;
  releasedAmount: bigint;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  revision: number;
  revisions: ContractRevision[];
  createdAt: string;
  updatedAt: string;
}

const MAX_MILESTONES = 20;
const MAX_REVISIONS = 50;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

/** Validate a milestones array into internal (bigint) milestones. */
function parseMilestones(input: unknown): InternalContract['milestones'] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
  }
  if (input.length > MAX_MILESTONES) {
    throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
  }
  return input.map((m: unknown, index: number) => {
    const raw =
      typeof m === 'number' || typeof m === 'string' || typeof m === 'boolean'
        ? { amount: m }
        : ((m ?? {}) as { title?: unknown; amount?: unknown });
    const amount = parseAmount(raw.amount, `milestone ${index} amount`);
    return {
      index,
      title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
      amount,
      released: false,
    };
  });
}

/** Sum milestone amounts with overflow check (mirrors contract checked_add). */
function sumMilestones(milestones: InternalContract['milestones']): bigint {
  let total = 0n;
  for (let i = 0; i < milestones.length; i++) {
    total = checkedAdd(total, milestones[i].amount, `milestone ${i} amount`);
  }
  return total;
}

/** JSON-safe snapshot of milestones for revision history. */
const publicMilestones = (milestones: InternalContract['milestones']): Milestone[] =>
  milestones.map((m) => ({
    index: m.index,
    title: m.title,
    amount: Number(m.amount),
    amountUnits: m.amount.toString(),
    released: m.released,
  }));

/** Project an internal contract to the public API shape. */
function toPublic(c: InternalContract): EscrowContract {
  return {
    id: c.id,
    title: c.title,
    client: c.client,
    freelancer: c.freelancer,
    token: c.token,
    milestones: publicMilestones(c.milestones),
    totalAmount: Number(c.totalAmount),    // deprecated
    totalAmountUnits: c.totalAmount.toString(),
    fundedAmount: Number(c.fundedAmount),  // deprecated
    fundedAmountUnits: c.fundedAmount.toString(),
    releasedAmount: Number(c.releasedAmount), // deprecated
    releasedAmountUnits: c.releasedAmount.toString(),
    status: c.status,
    reputationIssued: c.reputationIssued,
    dispute: c.dispute,
    chain: c.chain,
    revision: c.revision,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export class EscrowStore {
  private contracts = new Map<number, InternalContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private clientReputation = new Map<string, { completed: number; total: number }>();
  private reviews: Review[] = [];
  private nextReviewId = 1;
  private nextId = 1;

  list(filter: { status?: string; party?: string; linked?: boolean } = {}): EscrowContract[] {
    return [...this.contracts.values()]
      .filter(
        (c) =>
          (!filter.status || c.status === filter.status) &&
          (!filter.party || c.client === filter.party || c.freelancer === filter.party) &&
          (filter.linked === undefined || (filter.linked ? !!c.chain : !c.chain)),
      )
      .map(toPublic);
  }

  private getInternal(id: number): InternalContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  get(id: number): EscrowContract {
    return toPublic(this.getInternal(id));
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): EscrowContract {
    const { client, freelancer } = input;
    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    const milestones = parseMilestones(input.milestones);
    const totalAmount = sumMilestones(milestones);

    const now = new Date().toISOString();
    const c: InternalContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount,
      fundedAmount: 0n,
      releasedAmount: 0n,
      status: 'Created',
      reputationIssued: false,
      revision: 1,
      revisions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return toPublic(c);
  }

  edit(
    id: number,
    input: { client?: unknown; title?: unknown; milestones?: unknown },
  ): EscrowContract {
    const c = this.getInternal(id);
    if (input.client !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can edit this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0n) {
      throw new HttpError(409, 'contract_locked', 'Contract terms can only be edited before funding');
    }
    const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
    const hasMilestones = Object.prototype.hasOwnProperty.call(input, 'milestones');
    if (!hasTitle && !hasMilestones) {
      throw new HttpError(400, 'empty_patch', 'At least one of title or milestones must be provided');
    }

    const changes: ContractRevision['changes'] = [];
    let title: string | undefined;
    let milestones: InternalContract['milestones'] | undefined;
    let totalAmount: bigint | undefined;
    if (hasTitle) {
      title = typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement';
      if (title !== c.title) changes.push({ field: 'title', from: c.title, to: title });
    }
    if (hasMilestones) {
      milestones = parseMilestones(input.milestones);
      totalAmount = sumMilestones(milestones);
      const from = publicMilestones(c.milestones);
      const to = publicMilestones(milestones);
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changes.push({ field: 'milestones', from, to });
      }
    }

    const at = new Date().toISOString();
    if (title !== undefined) c.title = title;
    if (milestones && totalAmount !== undefined) {
      c.milestones = milestones;
      c.totalAmount = totalAmount;
    }
    c.revision += 1;
    c.revisions.push({ revision: c.revision, at, changes });
    if (c.revisions.length > MAX_REVISIONS) c.revisions.shift();
    c.updatedAt = at;
    return toPublic(c);
  }

  getRevisions(id: number): ContractRevision[] {
    return this.getInternal(id).revisions;
  }

  delete(id: number, clientRaw: unknown): void {
    const c = this.getInternal(id);
    if (clientRaw !== c.client) {
      throw new HttpError(403, 'forbidden', 'Only the client can withdraw this contract');
    }
    if (c.status !== 'Created' || c.fundedAmount !== 0n) {
      throw new HttpError(409, 'contract_locked', 'Contract can only be withdrawn before funding');
    }
    this.contracts.delete(id);
  }

  private requireActive(c: InternalContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  /**
   * Party check used when the request is authenticated (wallet auth). Mirrors
   * the contract's `require_auth()` rules. `caller === undefined` means the
   * request was not authenticated (auth disabled) and keeps legacy behaviour.
   */
  private requireClient(c: InternalContract, caller: string | undefined, action: string) {
    if (caller !== undefined && caller !== c.client) {
      throw new HttpError(403, 'forbidden', `Only the contract client can ${action}`);
    }
  }

  private touch(c: InternalContract): EscrowContract {
    c.updatedAt = new Date().toISOString();
    return toPublic(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors deposit_funds's client.require_auth() */
  deposit(id: number, amountRaw: unknown, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'deposit');
    this.requireActive(c);

    const amount = parseAmount(amountRaw, 'amount');

    const newFunded = checkedAdd(c.fundedAmount, amount, 'fundedAmount');
    if (newFunded > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount = newFunded;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors release_milestone's client.require_auth() */
  release(id: number, index: number, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'release milestones');
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');

    const balance = c.fundedAmount - c.releasedAmount;
    if (balance < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount = checkedAdd(c.releasedAmount, m.amount, 'releasedAmount');
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  /**
   * @security when `caller` (authenticated address) is given it must be the
   * client or freelancer — mirrors caller.require_auth(). A body `raisedBy` is
   * accepted for backwards compatibility but rejected (403) if it differs.
   */
  openDispute(id: number, raisedByRaw: unknown, reason: unknown, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    let raisedBy = raisedByRaw;
    if (caller !== undefined) {
      if (caller !== c.client && caller !== c.freelancer) {
        throw new HttpError(403, 'forbidden', 'Only the client or freelancer can open a dispute');
      }
      if (raisedByRaw !== undefined && raisedByRaw !== caller) {
        throw new HttpError(403, 'forbidden', 'raisedBy must match the authenticated address');
      }
      raisedBy = caller;
    } else if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy: raisedBy as string,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, freelancerBpsRaw: unknown): EscrowContract {
    const c = this.getInternal(id);
    if (c.status !== 'Disputed') {
      throw new HttpError(409, 'invalid_status', 'Only disputed contracts can be resolved');
    }
    const bps = Number(freelancerBpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer between 0 and 10000');
    }
    // Mirror the contract's integer arithmetic exactly:
    //   to_freelancer = held * bps / 10000  (integer division — truncation)
    //   to_client     = held - to_freelancer
    //   to_freelancer + to_client == held  (always)
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = (held * BigInt(bps)) / 10000n;
    c.releasedAmount = c.releasedAmount + toFreelancer;
    c.status = 'Resolved';
    if (c.dispute) {
      c.dispute.freelancerBps = bps;
      c.dispute.resolvedAt = new Date().toISOString();
    }
    return this.touch(c);
  }

  /** @security when `caller` is given it must equal contract.client — mirrors cancel_contract's client.require_auth() */
  cancel(id: number, caller?: string): EscrowContract {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'cancel');
    this.requireActive(c);
    c.status = 'Cancelled';
    return this.touch(c);
  }

  private validateComment(commentRaw: unknown): string | undefined {
    if (commentRaw === undefined || commentRaw === null) return undefined;
    if (typeof commentRaw !== 'string') {
      throw new HttpError(400, 'invalid_comment', 'comment must be a string');
    }
    const trimmed = commentRaw.trim();
    if (trimmed.length > 1000) {
      throw new HttpError(400, 'invalid_comment', 'comment must be at most 1000 characters');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new HttpError(400, 'invalid_comment', 'comment must not contain control characters');
    }
    return trimmed.length ? trimmed : undefined;
  }

  private validateRating(ratingRaw: unknown): number {
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    }
    return rating;
  }

  private applyReputation(
    map: Map<string, { completed: number; total: number }>,
    address: string,
    rating: number,
  ) {
    const r = map.get(address) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    map.set(address, r);
  }

  createReview(
    id: number,
    input: { reviewer?: unknown; rating?: unknown; comment?: unknown },
  ): Review {
    const c = this.getInternal(id);
    const { reviewer } = input;
    if (reviewer !== c.client && reviewer !== c.freelancer) {
      throw new HttpError(403, 'forbidden', 'Only the client or freelancer can review this contract');
    }
    if (c.status !== 'Completed' && c.status !== 'Resolved') {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
    const role: ReviewRole =
      reviewer === c.client ? 'client_to_freelancer' : 'freelancer_to_client';
    if (this.reviews.some((r) => r.contractId === id && r.role === role)) {
      throw new HttpError(409, 'already_reviewed', 'Review already submitted for this direction');
    }
    const rating = this.validateRating(input.rating);
    const comment = this.validateComment(input.comment);
    const reviewee = role === 'client_to_freelancer' ? c.freelancer : c.client;
    const review: Review = {
      id: this.nextReviewId++,
      contractId: id,
      reviewer: reviewer as string,
      reviewee,
      role,
      rating,
      createdAt: new Date().toISOString(),
    };
    if (comment !== undefined) review.comment = comment;
    if (c.status === 'Resolved') review.context = 'disputed';
    this.reviews.push(review);
    if (role === 'client_to_freelancer') {
      this.applyReputation(this.reputation, c.freelancer, rating);
      c.reputationIssued = true;
    } else {
      this.applyReputation(this.clientReputation, c.client, rating);
    }
    this.touch(c);
    return review;
  }

  /** @security when `caller` is given it must equal contract.client — mirrors issue_reputation's client.require_auth() */
  rate(id: number, ratingRaw: unknown, caller?: string): Reputation {
    const c = this.getInternal(id);
    this.requireClient(c, caller, 'issue reputation');
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can issue reputation');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'reputation_already_issued', 'Reputation already issued for this contract');
    }
    const rating = this.validateRating(ratingRaw);
    this.createReview(id, { reviewer: c.client, rating });
    return this.getReputation(c.freelancer);
  }

  async linkEscrow(
    id: number,
    escrowIdRaw: unknown,
    chainReader: import('./chain').ChainReader,
  ): Promise<EscrowContract> {
    const c = this.getInternal(id);
    if (typeof escrowIdRaw !== 'string' || !escrowIdRaw.trim()) {
      throw new HttpError(400, 'invalid_escrow_id', 'escrowId must be a non-empty string');
    }
    const escrowId = escrowIdRaw.trim();
    if (c.chain) {
      throw new HttpError(
        409,
        'already_linked',
        `Contract ${id} is already linked to on-chain escrow ${c.chain.escrowId}`,
      );
    }

    for (const other of this.contracts.values()) {
      if (other.id !== id && other.chain?.escrowId === escrowId) {
        throw new HttpError(
          409,
          'chain_escrow_taken',
          `On-chain escrow ${escrowId} is already linked to contract ${other.id}`,
        );
      }
    }

    let result: import('./chain').ChainReaderResult | null;
    try {
      result = await chainReader.getContract(escrowId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, 'chain_unavailable', 'Chain RPC service unavailable');
    }

    if (!result || !result.contract) {
      throw new HttpError(404, 'chain_contract_not_found', `On-chain escrow ${escrowId} not found`);
    }

    const onChain = result.contract;
    const mismatches: DriftItem[] = [];

    if (c.client !== onChain.client) {
      mismatches.push({ field: 'client', api: c.client, chain: onChain.client });
    }
    if (c.freelancer !== onChain.freelancer) {
      mismatches.push({ field: 'freelancer', api: c.freelancer, chain: onChain.freelancer });
    }
    if (c.token !== onChain.token) {
      mismatches.push({ field: 'token', api: c.token, chain: onChain.token });
    }

    const apiAmounts = c.milestones.map((m) => m.amount.toString());
    const chainAmounts = (onChain.milestones || []).map((m) => String(m.amount));
    if (apiAmounts.length !== chainAmounts.length) {
      mismatches.push({ field: 'milestones.count', api: apiAmounts.length, chain: chainAmounts.length });
    } else {
      for (let i = 0; i < apiAmounts.length; i++) {
        let equal = false;
        try {
          equal = BigInt(apiAmounts[i]) === BigInt(chainAmounts[i]);
        } catch {
          equal = apiAmounts[i] === chainAmounts[i];
        }
        if (!equal) {
          mismatches.push({ field: `milestones[${i}].amount`, api: apiAmounts[i], chain: chainAmounts[i] });
        }
      }
    }

    if (mismatches.length > 0) {
      throw new HttpError(409, 'chain_mismatch', 'API contract does not match on-chain escrow parameters', { mismatches });
    }

    const now = new Date().toISOString();
    c.chain = { escrowId, linkedAt: now, lastVerifiedAt: now, status: 'in_sync', drift: [] };
    return this.touch(c);
  }

  async checkParity(
    id: number,
    chainReader: import('./chain').ChainReader,
  ): Promise<{
    status: 'in_sync' | 'drift';
    drift: DriftItem[];
    checkedAt: string;
    latestLedger: number;
  }> {
    const c = this.getInternal(id);
    if (!c.chain) {
      throw new HttpError(409, 'not_linked', `Contract ${id} is not linked to any on-chain escrow`);
    }

    let result: import('./chain').ChainReaderResult | null;
    try {
      result = await chainReader.getContract(c.chain.escrowId);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, 'chain_unavailable', 'Chain RPC service unavailable');
    }

    if (!result || !result.contract) {
      throw new HttpError(404, 'chain_contract_not_found', `On-chain escrow ${c.chain.escrowId} not found`);
    }

    const onChain = result.contract;
    const drift: DriftItem[] = [];

    let fundedEqual = false;
    try {
      fundedEqual = c.fundedAmount === BigInt(String(onChain.fundedAmount));
    } catch {
      fundedEqual = c.fundedAmount.toString() === String(onChain.fundedAmount);
    }
    if (!fundedEqual) {
      drift.push({ field: 'fundedAmount', api: c.fundedAmount.toString(), chain: String(onChain.fundedAmount) });
    }

    let releasedEqual = false;
    try {
      releasedEqual = c.releasedAmount === BigInt(String(onChain.releasedAmount));
    } catch {
      releasedEqual = c.releasedAmount.toString() === String(onChain.releasedAmount);
    }
    if (!releasedEqual) {
      drift.push({ field: 'releasedAmount', api: c.releasedAmount.toString(), chain: String(onChain.releasedAmount) });
    }

    if (c.status !== onChain.status) {
      drift.push({ field: 'status', api: c.status, chain: onChain.status });
    }
    if (c.reputationIssued !== onChain.reputationIssued) {
      drift.push({ field: 'reputationIssued', api: c.reputationIssued, chain: onChain.reputationIssued });
    }

    const count = Math.min(c.milestones.length, (onChain.milestones || []).length);
    for (let i = 0; i < count; i++) {
      if (c.milestones[i].released !== onChain.milestones[i].released) {
        drift.push({ field: `milestones[${i}].released`, api: c.milestones[i].released, chain: onChain.milestones[i].released });
      }
    }

    const now = new Date().toISOString();
    const parityStatus = drift.length > 0 ? 'drift' : 'in_sync';
    c.chain.lastVerifiedAt = now;
    c.chain.status = parityStatus;
    c.chain.drift = drift;
    this.touch(c);

    return { status: parityStatus, drift, checkedAt: now, latestLedger: result.latestLedger };
  }

  getReputation(address: string): Reputation {
    const r = this.reputation.get(address) ?? { completed: 0, total: 0 };
    return {
      address,
      completedContracts: r.completed,
      totalRating: r.total,
      averageRating: r.completed ? Math.round((r.total / r.completed) * 100) / 100 : 0,
    };
  }

  getReputationWithClient(address: string): Reputation & {
    asClient: { completedContracts: number; averageRating: number };
  } {
    const base = this.getReputation(address);
    const cr = this.clientReputation.get(address) ?? { completed: 0, total: 0 };
    return {
      ...base,
      asClient: {
        completedContracts: cr.completed,
        averageRating: cr.completed ? Math.round((cr.total / cr.completed) * 100) / 100 : 0,
      },
    };
  }

  stats() {
    const all = [...this.contracts.values()];
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

    // Sum with bigint to match contract precision; expose as decimal strings.
    let totalEscrowedBig = 0n;
    let totalReleasedBig = 0n;
    for (const c of all) {
      totalEscrowedBig += c.fundedAmount - c.releasedAmount;
      totalReleasedBig += c.releasedAmount;
    }

    return {
      contracts: all.length,
      byStatus,
      /** @deprecated lossy above 2^53; use totalEscrowedUnits */
      totalEscrowed: Number(totalEscrowedBig),
      totalEscrowedUnits: totalEscrowedBig.toString(),
      /** @deprecated lossy above 2^53; use totalReleasedUnits */
      totalReleased: Number(totalReleasedBig),
      totalReleasedUnits: totalReleasedBig.toString(),
    };
  }

  listReviews(
    address: string,
    filter: { role?: string; limit?: number; cursor?: number } = {},
  ): { reviews: Review[]; nextCursor: number | null } {
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const all = this.reviews
      .filter((r) => r.reviewee === address)
      .filter((r) => !filter.role || r.role === filter.role)
      .sort((a, b) => b.id - a.id);
    const cursor = filter.cursor;
    const start = cursor ? all.findIndex((r) => r.id < cursor) : 0;
    const slice = all.slice(start < 0 ? 0 : start, start < 0 ? 0 : start + limit);
    const nextCursor = start < 0 ? null : start + limit < all.length ? slice[slice.length - 1]?.id ?? null : null;
    return { reviews: slice, nextCursor };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [
        { title: 'Wireframes', amount: 2500000 },
        { title: 'Visual design', amount: 5000000 },
        { title: 'Implementation', amount: 7500000 },
      ],
    });
    this.deposit(a.id, 15000000);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [{ title: 'Audit report', amount: 20000000 }],
    });
    this.deposit(b.id, 20000000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}
