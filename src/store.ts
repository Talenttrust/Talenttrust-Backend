/*
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

import { createHash } from 'node:crypto';

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

export interface ProfileLinks {
  website?: string;
  github?: string;
}

export interface Profile {
  address: string;
  displayName: string;
  bio?: string;
  skills: string[];
  links: ProfileLinks;
  updatedAt: string;
  nonce: number;
}

export interface ProfileInput {
  displayName?: unknown;
  bio?: unknown;
  skills?: unknown;
  links?: unknown;
}

const MAX_DISPLAY_NAME = 60;
const MAX_BIO = 1000;
const MAX_SKILLS = 20;
const MAX_SKILL_LEN = 30;
const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;

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

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private profiles = new Map<string, Profile>();
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
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer 1..5');
    }
    const r = this.reputation.get(c.freelancer) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    this.reputation.set(c.freelancer, r);
    c.reputationIssued = true;
    this.touch(c);
    return this.getReputation(c.freelancer);
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

  getProfile(address: string): Profile {
    const p = this.profiles.get(address);
    if (!p) throw new HttpError(404, 'profile_not_found', `Profile ${address} not found`);
    return p;
  }

  findProfile(address: string): Profile | null {
    return this.profiles.get(address) ?? null;
  }

  private validateProfile(input: ProfileInput): Omit<Profile, 'address' | 'updatedAt' | 'nonce'> {
    const { displayName, bio, skills, links } = input;
    if (typeof displayName !== 'string') {
      throw new HttpError(400, 'invalid_display_name', 'displayName must be a string');
    }
    const trimmedName = displayName.trim();
    if (trimmedName.length < 1 || trimmedName.length > MAX_DISPLAY_NAME) {
      throw new HttpError(400, 'invalid_display_name', `displayName must be 1..${MAX_DISPLAY_NAME} chars`);
    }
    let cleanBio: string | undefined;
    if (bio !== undefined && bio !== null) {
      if (typeof bio !== 'string') {
        throw new HttpError(400, 'invalid_bio', 'bio must be a string');
      }
      if (bio.length > MAX_BIO) {
        throw new HttpError(400, 'invalid_bio', `bio must be at most ${MAX_BIO} chars`);
      }
      cleanBio = bio;
    }
    if (!Array.isArray(skills)) {
      throw new HttpError(400, 'invalid_skills', 'skills must be an array');
    }
    if (skills.length > MAX_SKILLS) {
      throw new HttpError(400, 'invalid_skills', `at most ${MAX_SKILLS} skills`);
    }
    const cleanSkills: string[] = [];
    for (const s of skills) {
      if (typeof s !== 'string' || s.length < 1 || s.length > MAX_SKILL_LEN || !SKILL_SLUG.test(s)) {
        throw new HttpError(400, 'invalid_skill', `invalid skill slug: ${String(s)}`);
      }
      if (!cleanSkills.includes(s)) cleanSkills.push(s);
    }
    const rawLinks = (links ?? {}) as Record<string, unknown>;
    if (typeof rawLinks !== 'object' || Array.isArray(rawLinks)) {
      throw new HttpError(400, 'invalid_links', 'links must be an object');
    }
    const cleanLinks: ProfileLinks = {};
    for (const key of ['website', 'github'] as const) {
      const v = rawLinks[key];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !HTTPS_URL.test(v)) {
        throw new HttpError(400, 'invalid_link', `${key} must be an https URL`);
      }
      cleanLinks[key] = v;
    }
    return { displayName: trimmedName, bio: cleanBio, skills: cleanSkills, links: cleanLinks };
  }

  setProfile(address: string, input: ProfileInput, nonce: number): Profile {
    const existing = this.profiles.get(address);
    if (existing && nonce <= existing.nonce) {
      throw new HttpError(409, 'stale_nonce', 'nonce must be strictly greater than stored nonce');
    }
    const clean = this.validateProfile(input);
    const profile: Profile = {
      address,
      ...clean,
      updatedAt: new Date().toISOString(),
      nonce,
    };
    this.profiles.set(address, profile);
    return profile;
  }

  searchProfiles(filter: { skill?: string; limit?: number; cursor?: string } = {}): {
    items: Profile[];
    nextCursor: string | null;
  } {
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    let all = [...this.profiles.values()];
    if (filter.skill) all = all.filter((p) => p.skills.includes(filter.skill as string));
    all.sort((a, b) => {
      const diff = this.getReputation(b.address).averageRating - this.getReputation(a.address).averageRating;
      if (diff !== 0) return diff;
      return a.address.localeCompare(b.address);
    });
    let start = 0;
    if (filter.cursor) {
      const idx = all.findIndex((p) => p.address === filter.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? page[page.length - 1].address : null;
    return { items: page, nextCursor };
  }
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function profileSigningMessage(address: string, nonce: number, profile: unknown): string {
  const hash = createHash('sha256').update(canonicalize(profile)).digest('hex');
  return `talenttrust-profile:v1:${address}:${nonce}:${hash}`;
}
