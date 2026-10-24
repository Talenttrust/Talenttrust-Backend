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
  amount: number | string;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  toFreelancer?: number;
  toClient?: number;
  resolvedAt?: string;
}

export interface Settlement {
  kind: 'cancel' | 'dispute';
  toFreelancer: number;
  toClient: number;
  at: string;
}

export interface LedgerEntry {
  type: 'deposit' | 'release' | 'dispute_payout' | 'refund';
  amount: number;
  milestoneIndex?: number;
  at: string;
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
  totalAmount: number | string;
  fundedAmount: number | string;
  depositedAmount: number;
  releasedAmount: number | string;
  refundedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  createdAt: string;
  updatedAt: string;
  settlement?: Settlement;
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
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

function assertBalanced(c: EscrowContract): void {
  const escrow = c.fundedAmount - c.releasedAmount;
  const expected = c.releasedAmount + c.refundedAmount + escrow;
  if (c.depositedAmount !== expected) {
    throw new Error(
      `ledger imbalance for contract ${c.id}: deposited=${c.depositedAmount} ` +
        `released=${c.releasedAmount} refunded=${c.refundedAmount} escrow=${escrow}`,
    );
  }
}

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private nextId = 1;

  list(filter: { status?: string; party?: string; linked?: boolean } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party) &&
        (filter.linked === undefined || (filter.linked ? !!c.chain : !c.chain)),
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
      const raw = (typeof m === 'number' || typeof m === 'string' ? { amount: m } : m) as {
        title?: unknown;
        amount?: unknown;
      };
      let amount: number | string;
      if (typeof raw?.amount === 'string' && /^\d+$/.test(raw.amount.trim())) {
        amount = raw.amount.trim();
      } else {
        const num = Number(raw?.amount);
        if (!Number.isFinite(num) || num <= 0) {
          throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
        }
        amount = num;
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });

    const hasBig = milestones.some((m) => typeof m.amount === 'string');
    const totalAmount = hasBig
      ? milestones.reduce<bigint>((s, m) => s + BigInt(m.amount), 0n).toString()
      : milestones.reduce<number>((s, m) => s + Number(m.amount), 0);

    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount,
      fundedAmount: hasBig ? '0' : 0,
      depositedAmount: 0,
      releasedAmount: hasBig ? '0' : 0,
      refundedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
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
    const isBig =
      typeof c.totalAmount === 'string' ||
      (typeof amountRaw === 'string' && /^\d+$/.test(amountRaw));

    if (isBig) {
      let amount: bigint;
      try {
        amount = BigInt(String(amountRaw));
      } catch {
        throw new HttpError(400, 'invalid_amount', 'amount must be positive');
      }
      if (amount <= 0n) {
        throw new HttpError(400, 'invalid_amount', 'amount must be positive');
      }
      const curFunded = BigInt(String(c.fundedAmount));
      const total = BigInt(String(c.totalAmount));
      if (curFunded + amount > total) {
        throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
      }
      c.fundedAmount = (curFunded + amount).toString();
      if (BigInt(c.fundedAmount) === total) c.status = 'Funded';
      return this.touch(c);
    }

    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (Number(c.fundedAmount) + amount > Number(c.totalAmount)) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount = Number(c.fundedAmount) + amount;
    c.depositedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    assertBalanced(c);
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');

    const isBig = typeof c.totalAmount === 'string' || typeof m.amount === 'string';
    if (isBig) {
      const balance = BigInt(String(c.fundedAmount)) - BigInt(String(c.releasedAmount));
      const needed = BigInt(String(m.amount));
      if (balance < needed) {
        throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
      }
      m.released = true;
      c.releasedAmount = (BigInt(String(c.releasedAmount)) + needed).toString();
      if (c.milestones.every((x) => x.released)) c.status = 'Completed';
      return this.touch(c);
    }

    if (Number(c.fundedAmount) - Number(c.releasedAmount) < Number(m.amount)) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount = Number(c.releasedAmount) + Number(m.amount);
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    assertBalanced(c);
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
    assertBalanced(c);
    return this.touch(c);
  }

  resolveDispute(id: number, freelancerBpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed') {
      throw new HttpError(409, 'invalid_status', 'Only disputed contracts can be resolved');
    }
    const bps = Number(freelancerBpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer between 0 and 10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    const toClient = held - toFreelancer;
    const at = new Date().toISOString();
    c.releasedAmount = Number(c.releasedAmount) + toFreelancer;
    c.refundedAmount = Number(c.refundedAmount) + toClient;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    if (c.dispute) {
      c.dispute.freelancerBps = bps;
      c.dispute.toFreelancer = toFreelancer;
      c.dispute.toClient = toClient;
      c.dispute.resolvedAt = at;
    }
    c.settlement = { kind: 'dispute', toFreelancer, toClient, at };
    assertBalanced(c);
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const toClient = c.fundedAmount - c.releasedAmount;
    const at = new Date().toISOString();
    c.refundedAmount += toClient;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    c.settlement = { kind: 'cancel', toFreelancer: 0, toClient, at };
    assertBalanced(c);
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can issue reputation');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'reputation_already_issued', 'Reputation already issued for this contract');
    }
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    }
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
  }

  ledger(id: number): LedgerEntry[] {
    const c = this.get(id);
    const entries: LedgerEntry[] = [];
    if (c.depositedAmount > 0) {
      entries.push({ type: 'deposit', amount: c.depositedAmount, at: c.createdAt });
    }
    for (const m of c.milestones) {
      if (m.released) {
        entries.push({
          type: 'release',
          amount: m.amount,
          milestoneIndex: m.index,
          at: c.updatedAt,
        });
      }
    }
    if (c.settlement) {
      if (c.settlement.kind === 'dispute') {
        if (c.settlement.toFreelancer > 0) {
          entries.push({
            type: 'dispute_payout',
            amount: c.settlement.toFreelancer,
            at: c.settlement.at,
          });
        }
        if (c.settlement.toClient > 0) {
          entries.push({ type: 'refund', amount: c.settlement.toClient, at: c.settlement.at });
        }
      } else if (c.settlement.toClient > 0) {
        entries.push({ type: 'refund', amount: c.settlement.toClient, at: c.settlement.at });
      }
    }
    return entries;
  }

  async linkEscrow(
    id: number,
    escrowIdRaw: unknown,
    chainReader: import('./chain').ChainReader,
  ): Promise<EscrowContract> {
    const c = this.get(id);
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

    // Check if another contract is already linked to this escrowId
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
      throw new HttpError(
        404,
        'chain_contract_not_found',
        `On-chain escrow ${escrowId} not found`,
      );
    }

    const onChain = result.contract;
    const mismatches: DriftItem[] = [];

    // Compare client
    if (c.client !== onChain.client) {
      mismatches.push({ field: 'client', api: c.client, chain: onChain.client });
    }

    // Compare freelancer
    if (c.freelancer !== onChain.freelancer) {
      mismatches.push({ field: 'freelancer', api: c.freelancer, chain: onChain.freelancer });
    }

    // Compare token
    if (c.token !== onChain.token) {
      mismatches.push({ field: 'token', api: c.token, chain: onChain.token });
    }

    // Compare milestones: amounts and count (exact BigInt comparison)
    const apiAmounts = c.milestones.map((m) => String(m.amount));
    const chainAmounts = (onChain.milestones || []).map((m) => String(m.amount));
    if (apiAmounts.length !== chainAmounts.length) {
      mismatches.push({
        field: 'milestones.count',
        api: apiAmounts.length,
        chain: chainAmounts.length,
      });
    } else {
      for (let i = 0; i < apiAmounts.length; i++) {
        let equal = false;
        try {
          equal = BigInt(apiAmounts[i]) === BigInt(chainAmounts[i]);
        } catch {
          equal = apiAmounts[i] === chainAmounts[i];
        }
        if (!equal) {
          mismatches.push({
            field: `milestones[${i}].amount`,
            api: apiAmounts[i],
            chain: chainAmounts[i],
          });
        }
      }
    }

    if (mismatches.length > 0) {
      throw new HttpError(
        409,
        'chain_mismatch',
        'API contract does not match on-chain escrow parameters',
        {
          mismatches,
        },
      );
    }

    const now = new Date().toISOString();
    c.chain = {
      escrowId,
      linkedAt: now,
      lastVerifiedAt: now,
      status: 'in_sync',
      drift: [],
    };
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
    const c = this.get(id);
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
      throw new HttpError(
        404,
        'chain_contract_not_found',
        `On-chain escrow ${c.chain.escrowId} not found`,
      );
    }

    const onChain = result.contract;
    const drift: DriftItem[] = [];

    // Compare fundedAmount (exact string/bigint comparison)
    let fundedEqual = false;
    try {
      fundedEqual = BigInt(String(c.fundedAmount)) === BigInt(String(onChain.fundedAmount));
    } catch {
      fundedEqual = String(c.fundedAmount) === String(onChain.fundedAmount);
    }
    if (!fundedEqual) {
      drift.push({
        field: 'fundedAmount',
        api: String(c.fundedAmount),
        chain: String(onChain.fundedAmount),
      });
    }

    // Compare releasedAmount (exact string/bigint comparison)
    let releasedEqual = false;
    try {
      releasedEqual = BigInt(String(c.releasedAmount)) === BigInt(String(onChain.releasedAmount));
    } catch {
      releasedEqual = String(c.releasedAmount) === String(onChain.releasedAmount);
    }
    if (!releasedEqual) {
      drift.push({
        field: 'releasedAmount',
        api: String(c.releasedAmount),
        chain: String(onChain.releasedAmount),
      });
    }

    // Compare status
    if (c.status !== onChain.status) {
      drift.push({ field: 'status', api: c.status, chain: onChain.status });
    }

    // Compare reputationIssued
    if (c.reputationIssued !== onChain.reputationIssued) {
      drift.push({
        field: 'reputationIssued',
        api: c.reputationIssued,
        chain: onChain.reputationIssued,
      });
    }

    // Compare per-milestone released status
    const count = Math.min(c.milestones.length, (onChain.milestones || []).length);
    for (let i = 0; i < count; i++) {
      if (c.milestones[i].released !== onChain.milestones[i].released) {
        drift.push({
          field: `milestones[${i}].released`,
          api: c.milestones[i].released,
          chain: onChain.milestones[i].released,
        });
      }
    }

    const now = new Date().toISOString();
    const parityStatus = drift.length > 0 ? 'drift' : 'in_sync';
    c.chain.lastVerifiedAt = now;
    c.chain.status = parityStatus;
    c.chain.drift = drift;
    this.touch(c);

    return {
      status: parityStatus,
      drift,
      checkedAt: now,
      latestLedger: result.latestLedger,
    };
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

  stats() {
    const all = this.list();
    const byStatus: Record<string, number> = {};
    for (const c of all) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    const releasedViaMilestones = all.reduce(
      (s, c) => s + c.milestones.reduce((ms, m) => ms + (m.released ? m.amount : 0), 0),
      0,
    );
    const releasedViaDisputes = all.reduce(
      (s, c) => s + (c.settlement?.kind === 'dispute' ? c.settlement.toFreelancer : 0),
      0,
    );
    return {
      contracts: all.length,
      byStatus,
      totalEscrowed: all.reduce((s, c) => s + (c.fundedAmount - c.releasedAmount), 0),
      totalDeposited: all.reduce((s, c) => s + c.depositedAmount, 0),
      totalRefunded: all.reduce((s, c) => s + c.refundedAmount, 0),
      totalReleased: releasedViaMilestones + releasedViaDisputes,
      releasedViaMilestones,
      releasedViaDisputes,
    };
  }

  /** Seed a few demo engagements so the API is explorable out of the box. */
  seed(): this {
    const a = this.create({
      title: 'Landing page redesign',
      client: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      freelancer: 'GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [
        { title: 'Wireframes', amount: 250 },
        { title: 'Visual design', amount: 500 },
        { title: 'Implementation', amount: 750 },
      ],
    });
    this.deposit(a.id, 1500);
    this.release(a.id, 0);
    const b = this.create({
      title: 'Smart contract audit',
      client: 'GCLIENTDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      freelancer: 'GFREELANCERDEMOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      token: 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      milestones: [{ title: 'Audit report', amount: 2000 }],
    });
    this.deposit(b.id, 2000);
    this.release(b.id, 0);
    this.rate(b.id, 5);
    return this;
  }
}