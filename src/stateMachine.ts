import { HttpError, type ContractStatus, type EscrowContract } from './store';

export type Action = 'deposit' | 'release' | 'dispute' | 'resolve' | 'cancel' | 'rate';
export type Actor = 'client' | 'freelancer' | 'party' | 'admin';
export interface GuardFailure { status: number; code: string; reason: string }
export interface ActionArgs {
  amount?: unknown;
  index?: number;
  raisedBy?: unknown;
  freelancerBps?: unknown;
  rating?: unknown;
}
interface Transition {
  from: ContractStatus[];
  actor: Actor;
  actorEnforced: boolean;
  statusReason?: string;
  guard?: (c: EscrowContract, args: ActionArgs) => GuardFailure | null;
  next: { status: ContractStatus; when: string };
  nextStatus: (c: EscrowContract) => ContractStatus;
}
const fail = (status: number, code: string, reason: string): GuardFailure => ({ status, code, reason });
export const usesBigDeposit = (c: EscrowContract, amount: unknown) =>
  typeof c.totalAmount === 'string' || (typeof amount === 'string' && /^\d+$/.test(amount));

export const TRANSITIONS: Record<Action, Transition> = {
  deposit: {
    from: ['Created', 'Funded'], actor: 'client', actorEnforced: false,
    guard: (c, { amount: raw }) => {
      if (usesBigDeposit(c, raw)) {
        let amount: bigint;
        try { amount = BigInt(String(raw)); } catch {
          return fail(400, 'invalid_amount', 'amount must be positive');
        }
        if (amount <= 0n) return fail(400, 'invalid_amount', 'amount must be positive');
        if (BigInt(String(c.fundedAmount)) + amount > BigInt(String(c.totalAmount))) {
          return fail(409, 'over_funded', 'deposit exceeds contract total');
        }
      } else {
        const amount = Number(raw);
        if (!Number.isFinite(amount) || amount <= 0) return fail(400, 'invalid_amount', 'amount must be positive');
        if (Number(c.fundedAmount) + amount > Number(c.totalAmount)) {
          return fail(409, 'over_funded', 'deposit exceeds contract total');
        }
      }
      return null;
    },
    next: { status: 'Funded', when: 'fully funded' },
    nextStatus: (c) => (typeof c.fundedAmount === 'string'
      ? BigInt(c.fundedAmount) === BigInt(c.totalAmount)
      : c.fundedAmount === c.totalAmount) ? 'Funded' : c.status,
  },
  release: {
    from: ['Created', 'Funded'], actor: 'client', actorEnforced: false,
    guard: (c, { index }) => {
      const m = c.milestones[index as number];
      if (!m) return fail(404, 'milestone_not_found', `Milestone ${index} not found`);
      if (m.released) return fail(409, 'already_released', 'Milestone already released');
      const insufficient = typeof c.totalAmount === 'string' || typeof m.amount === 'string'
        ? BigInt(c.fundedAmount) - BigInt(c.releasedAmount) < BigInt(m.amount)
        : Number(c.fundedAmount) - Number(c.releasedAmount) < Number(m.amount);
      return insufficient ? fail(409, 'insufficient_funds', 'Escrow balance too low for this milestone') : null;
    },
    next: { status: 'Completed', when: 'all milestones released' },
    nextStatus: (c) => c.milestones.every((m) => m.released) ? 'Completed' : c.status,
  },
  dispute: {
    from: ['Created', 'Funded'], actor: 'party', actorEnforced: true,
    next: { status: 'Disputed', when: 'always' }, nextStatus: () => 'Disputed',
  },
  resolve: {
    from: ['Disputed'], actor: 'admin', actorEnforced: false,
    statusReason: 'Only disputed contracts can be resolved',
    guard: (_c, { freelancerBps }) => {
      const bps = Number(freelancerBps);
      return Number.isInteger(bps) && bps >= 0 && bps <= 10000 ? null
        : fail(400, 'invalid_split', 'freelancerBps must be an integer between 0 and 10000');
    },
    next: { status: 'Resolved', when: 'always' }, nextStatus: () => 'Resolved',
  },
  cancel: {
    from: ['Created', 'Funded'], actor: 'client', actorEnforced: false,
    next: { status: 'Cancelled', when: 'always' }, nextStatus: () => 'Cancelled',
  },
  rate: {
    from: ['Completed'], actor: 'client', actorEnforced: false,
    statusReason: 'Only completed contracts can issue reputation',
    guard: (c, { rating: raw }) => {
      if (c.reputationIssued) return fail(409, 'reputation_already_issued', 'Reputation already issued for this contract');
      const rating = Number(raw);
      return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? null
        : fail(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    },
    next: { status: 'Completed', when: 'reputation issued' }, nextStatus: () => 'Completed',
  },
};

// Existence is checked by store.get before this function. Roles describe intent;
// only dispute enforces an actor today. Do not invent admin identity/authentication.
export function checkAllowed(action: Action, c: EscrowContract, args: ActionArgs): GuardFailure | null {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(c.status)) return fail(409, 'invalid_status', rule.statusReason ?? `Contract is ${c.status}`);
  if (rule.actorEnforced && rule.actor === 'party' && args.raisedBy !== c.client && args.raisedBy !== c.freelancer) {
    return fail(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
  }
  return rule.guard?.(c, args) ?? null;
}

export function assertAllowed(action: Action, c: EscrowContract, args: ActionArgs = {}): void {
  const failure = checkAllowed(action, c, args);
  if (failure) throw new HttpError(failure.status, failure.code, failure.reason);
}

export interface AllowedAction {
  action: Action;
  allowed: boolean;
  reason?: string;
  code?: string;
  params?: { index?: number[]; maxDeposit?: number | string };
}

export function allowedActions(c: EscrowContract, as?: string) {
  const actions = (Object.keys(TRANSITIONS) as Action[]).map((action): AllowedAction => {
    const args: ActionArgs = { raisedBy: as, freelancerBps: 5000, rating: 5 };
    let params: AllowedAction['params'];
    if (action === 'deposit') {
      const maxDeposit = typeof c.totalAmount === 'string' || typeof c.fundedAmount === 'string'
        ? (BigInt(c.totalAmount) - BigInt(c.fundedAmount)).toString()
        : Number(c.totalAmount) - Number(c.fundedAmount);
      // A positive probe returns over_funded (not invalid_amount) when full.
      args.amount = Number(maxDeposit) > 0 ? maxDeposit : 1;
      params = { maxDeposit };
    }
    if (action === 'release') {
      const index = c.milestones.filter((m) => !checkAllowed(action, c, { index: m.index })).map((m) => m.index);
      args.index = index[0] ?? c.milestones.find((m) => !m.released)?.index ?? 0;
      params = { index };
    }
    const failure = checkAllowed(action, c, args);
    return { action, allowed: !failure, ...(failure ? { reason: failure.reason, code: failure.code } : {}), ...(params ? { params } : {}) };
  });
  return { status: c.status, actions };
}

export function describeStateMachine() {
  const transitions = (Object.keys(TRANSITIONS) as Action[]).map((action) => {
    const { from, actor, actorEnforced, next } = TRANSITIONS[action];
    return { action, from, actor, actorEnforced, next };
  });
  const lines = transitions.flatMap(({ action, from, next }) => from.map((status) =>
    `    ${status} --> ${next.status}: ${action}${next.when === 'always' ? '' : ` [${next.when}]`}`));
  // Conditional operations retain their source status until their condition holds.
  for (const { action, from, next } of transitions) {
    if (next.when === 'fully funded' || next.when === 'all milestones released') {
      for (const status of from) if (status !== next.status) lines.push(`    ${status} --> ${status}: ${action} [otherwise]`);
    }
  }
  return { checkOrder: ['existence', 'status', 'actor', 'guards'], transitions, mermaid: ['stateDiagram-v2', ...lines].join('\n') };
}
