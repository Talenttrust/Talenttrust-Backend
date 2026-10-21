import { assertAllowed, TRANSITIONS, usesBigDeposit } from './stateMachine';
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
  totalAmount: number | string;
  fundedAmount: number | string;
  releasedAmount: number | string;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
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
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;

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
      ? milestones.reduce((s, m) => s + BigInt(m.amount), 0n).toString()
      : milestones.reduce((s, m) => s + Number(m.amount), 0);

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
      releasedAmount: hasBig ? '0' : 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private touch(c: EscrowContract) {
    c.updatedAt = new Date().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    assertAllowed('deposit', c, { amount: amountRaw });
    c.fundedAmount = usesBigDeposit(c, amountRaw)
      ? (BigInt(String(c.fundedAmount)) + BigInt(String(amountRaw))).toString()
      : Number(c.fundedAmount) + Number(amountRaw);
    c.status = TRANSITIONS.deposit.nextStatus(c);
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    assertAllowed('release', c, { index });
    const m = c.milestones[index];
    c.releasedAmount = typeof c.totalAmount === 'string' || typeof m.amount === 'string'
      ? (BigInt(String(c.releasedAmount)) + BigInt(String(m.amount))).toString()
      : Number(c.releasedAmount) + Number(m.amount);
    m.released = true;
    c.status = TRANSITIONS.release.nextStatus(c);
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    assertAllowed('dispute', c, { raisedBy });
    c.status = TRANSITIONS.dispute.nextStatus(c);
    c.dispute = {
      raisedBy: raisedBy as string,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, freelancerBpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    assertAllowed('resolve', c, { freelancerBps: freelancerBpsRaw });
    const bps = Number(freelancerBpsRaw);
    const remaining = Number(c.fundedAmount) - Number(c.releasedAmount);
    const toFreelancer = Math.round((remaining * bps) / 10000);
    c.releasedAmount = Number(c.releasedAmount) + toFreelancer;
    c.status = TRANSITIONS.resolve.nextStatus(c);
    if (c.dispute) {
      c.dispute.freelancerBps = bps;
      c.dispute.resolvedAt = new Date().toISOString();
    }
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    assertAllowed('cancel', c);
    c.status = TRANSITIONS.cancel.nextStatus(c);
    return this.touch(c);
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    assertAllowed('rate', c, { rating: ratingRaw });
    const rating = Number(ratingRaw);
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    c.status = TRANSITIONS.rate.nextStatus(c);
    this.touch(c);
    return this.getReputation(c.freelancer);
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
    return {
      contracts: all.length,
      byStatus,
      totalEscrowed: all.reduce(
        (s, c) => s + (Number(c.fundedAmount) - Number(c.releasedAmount)),
        0,
      ),
      totalReleased: all.reduce((s, c) => s + Number(c.releasedAmount), 0),
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
