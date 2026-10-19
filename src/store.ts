import { createHash } from 'node:crypto';

/**
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

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
  amount: number;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
  evidenceDigest?: string;
}

export type EvidenceKind = 'text' | 'link' | 'file_hash';

export interface Evidence {
  id: string;
  contractId: number;
  submittedBy: string;
  kind: EvidenceKind;
  text?: string;
  url?: string;
  sha256?: string;
  fileName?: string;
  submittedAt: string;
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  totalAmount: number;
  fundedAmount: number;
  releasedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  createdAt: string;
  updatedAt: string;
}

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];
const MAX_EVIDENCE_PER_PARTY = 20;
const MAX_EVIDENCE_TEXT = 4000;
const MAX_EVIDENCE_FILENAME = 200;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000e-\u001F\u007F]/;

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private evidence = new Map<number, Evidence[]>();
  private nextId = 1;

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
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
    if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (input.milestones.length > MAX_MILESTONES) {
      throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    }
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });
    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount: milestones.reduce((s, m) => s + m.amount, 0),
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!Active.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = new Date().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (c.fundedAmount + amount > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');
    if (c.fundedAmount - c.releasedAmount < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount += m.amount;
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  private normaliseText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') {
      throw new HttpError(400, 'invalid_evidence', `${field} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new HttpError(400, 'invalid_evidence', `${field} must not be empty`);
    }
    if (trimmed.length > max) {
      throw new HttpError(400, 'invalid_evidence', `${field} must be at most ${max} characters`);
    }
    if (CONTROL_CHARS.test(trimmed)) {
      throw new HttpError(400, 'invalid_evidence', `${field} contains control characters`);
    }
    return trimmed;
  }

  private canonicalEvidence(items: Evidence[]): string {
    return JSON.stringify(
      items.map((e) => ({
        id: e.id,
        contractId: e.contractId,
        submittedBy: e.submittedBy,
        kind: e.kind,
        text: e.text ?? null,
        url: e.url ?? null,
        sha256: e.sha256 ?? null,
        fileName: e.fileName ?? null,
        submittedAt: e.submittedAt,
      })),
    );
  }

  evidenceDigest(items: Evidence[]): string {
    return createHash('sha256').update(this.canonicalEvidence(items)).digest('hex');
  }

  listEvidence(id: number): { data: Evidence[]; digest: string } {
    const c = this.get(id);
    if (!c.dispute) {
      throw new HttpError(409, 'dispute_not_open', 'Contract has no dispute');
    }
    const items = [...(this.evidence.get(id) ?? [])].sort((a, b) =>
      a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0,
    );
    return { data: items, digest: this.evidenceDigest(items) };
  }

  addEvidence(
    id: number,
    input: { submittedBy?: unknown; kind?: unknown; text?: unknown; url?: unknown; sha256?: unknown; fileName?: unknown },
  ): Evidence {
    const c = this.get(id);
    if (input.submittedBy !== c.client && input.submittedBy !== c.freelancer) {
      throw new HttpError(403, 'forbidden', 'Only the client or freelancer can submit evidence');
    }
    if (c.status === 'Resolved') {
      throw new HttpError(409, 'dispute_closed', 'Dispute is already resolved');
    }
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'dispute_not_open', 'Contract is not disputed');
    }
    const existing = this.evidence.get(id) ?? [];
    const submittedBy = input.submittedBy as string;
    const partyCount = existing.filter((e) => e.submittedBy === submittedBy).length;
    if (partyCount >= MAX_EVIDENCE_PER_PARTY) {
      throw new HttpError(409, 'evidence_limit_reached', `At most ${MAX_EVIDENCE_PER_PARTY} evidence items per party`);
    }
    const kind = input.kind;
    if (kind !== 'text' && kind !== 'link' && kind !== 'file_hash') {
      throw new HttpError(400, 'invalid_evidence', 'kind must be text, link or file_hash');
    }
    const item: Evidence = {
      id: `ev_${id}_${existing.length + 1}`,
      contractId: id,
      submittedBy,
      kind,
      submittedAt: new Date().toISOString(),
    };
    if (kind === 'text') {
      item.text = this.normaliseText(input.text, 'text', MAX_EVIDENCE_TEXT);
    } else if (kind === 'link') {
      const url = this.normaliseText(input.url, 'url', 2048);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, 'invalid_evidence', 'url must be a valid https URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new HttpError(400, 'invalid_evidence', 'url must use https');
      }
      item.url = url;
    } else {
      if (typeof input.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input.sha256)) {
        throw new HttpError(400, 'invalid_evidence', 'sha256 must be 64 hex characters');
      }
      item.sha256 = input.sha256.toLowerCase();
      if (input.fileName !== undefined) {
        item.fileName = this.normaliseText(input.fileName, 'fileName', MAX_EVIDENCE_FILENAME);
      }
    }
    existing.push(item);
    this.evidence.set(id, existing);
    return item;
  }

  resolveDispute(id: number, bpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const bps = Number(bpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer 0..10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    c.releasedAmount += toFreelancer;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    c.dispute.freelancerBps = bps;
    c.dispute.resolvedAt = new Date().toISOString();
    const items = this.evidence.get(id) ?? [];
    c.dispute.evidenceDigest = this.evidenceDigest(items);
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can be rated');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'already_rated', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be between 1 and 5');
    }
    c.reputationIssued = true;
    const address = c.freelancer;
    const current = this.reputation.get(address) ?? { completed: 0, total: 0 };
    const next = { completed: current.completed + 1, total: current.total + rating };
    this.reputation.set(address, next);
    this.touch(c);
    return {
      address,
      completedContracts: next.completed,
      totalRating: next.total,
      averageRating: next.total / next.completed,
    };
  }

  getReputation(address: string): Reputation {
    const r = this.reputation.get(address) ?? { completed: 0, total: 0 };
    return {
      address,
      completedContracts: r.completed,
      totalRating: r.total,
      averageRating: r.completed ? r.total / r.completed : 0,
    };
  }
}
