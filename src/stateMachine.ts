/**
 * Declarative escrow state machine. The store enforces its lifecycle rules
 * through this table and the action-discovery endpoint reads the same table,
 * so "what can I do now?" can never drift from what the mutations accept.
 *
 * Check order for every action: existence (store lookup), actor, status,
 * guards. That is the order the API has always reported errors in.
 */
import { HttpError } from './amount-error';
import { checkedAdd, parseAmount } from './amount';

export type Action = 'deposit' | 'release' | 'dispute' | 'resolve' | 'cancel' | 'rate';
export type Actor = 'client' | 'freelancer' | 'party' | 'admin';
export type MachineStatus = 'Created' | 'Funded' | 'Completed' | 'Disputed' | 'Resolved' | 'Cancelled' | 'Expired';

/** The parts of a stored contract the rules look at (amounts in base units). */
export interface MachineContract {
  status: MachineStatus;
  client: string;
  freelancer: string;
  milestones: Array<{ index: number; amount: bigint; released: boolean }>;
  totalAmount: bigint;
  fundedAmount: bigint;
  releasedAmount: bigint;
  reputationIssued: boolean;
}

export interface GuardFailure {
  status: number;
  code: string;
  reason: string;
}

export interface ActionArgs {
  amount?: unknown;
  index?: number;
  raisedBy?: unknown;
  freelancerBps?: unknown;
  rating?: unknown;
}

interface Transition {
  from: MachineStatus[];
  actor: Actor;
  /**
   * Whether the store itself checks the actor for unauthenticated calls. Client-only
   * actions are enforced for wallet-authenticated callers and resolve by scoped API
   * keys (see README), so they are advisory here.
   */
  actorEnforced: boolean;
  statusFailure: (status: MachineStatus) => GuardFailure;
  guard?: (c: MachineContract, args: ActionArgs) => GuardFailure | null;
  next: { status: MachineStatus; when: string };
  nextStatus: (c: MachineContract) => MachineStatus;
}

const fail = (status: number, code: string, reason: string): GuardFailure => ({ status, code, reason });

/** Turn a thrown HttpError (e.g. from parseAmount) into a guard failure. */
const fromError = (fn: () => void): GuardFailure | null => {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.code, err.message);
    throw err;
  }
};

/** Live (Created/Funded) contracts only; an expired one says so. */
const notActive = (status: MachineStatus): GuardFailure =>
  status === 'Expired'
    ? fail(409, 'contract_expired', 'Contract funding deadline has passed')
    : fail(409, 'contract_not_active', `Contract is ${status}`);

export const TRANSITIONS: Record<Action, Transition> = {
  deposit: {
    from: ['Created', 'Funded'],
    actor: 'client',
    actorEnforced: false,
    statusFailure: notActive,
    guard: (c, { amount: raw }) => {
      let over = false;
      const failure = fromError(() => {
        const amount = parseAmount(raw, 'amount');
        over = checkedAdd(c.fundedAmount, amount, 'fundedAmount') > c.totalAmount;
      });
      if (failure) return failure;
      return over ? fail(409, 'over_funded', 'deposit exceeds contract total') : null;
    },
    next: { status: 'Funded', when: 'fully funded' },
    nextStatus: (c) => (c.fundedAmount === c.totalAmount ? 'Funded' : c.status),
  },
  release: {
    from: ['Created', 'Funded'],
    actor: 'client',
    actorEnforced: false,
    statusFailure: notActive,
    guard: (c, { index }) => {
      const m = c.milestones[index as number];
      if (!m) return fail(404, 'milestone_not_found', `Milestone ${index} not found`);
      if (m.released) return fail(409, 'already_released', 'Milestone already released');
      return c.fundedAmount - c.releasedAmount < m.amount
        ? fail(409, 'insufficient_funds', 'Escrow balance too low for this milestone')
        : null;
    },
    next: { status: 'Completed', when: 'all milestones released' },
    nextStatus: (c) => (c.milestones.every((m) => m.released) ? 'Completed' : c.status),
  },
  dispute: {
    from: ['Created', 'Funded'],
    actor: 'party',
    actorEnforced: true,
    statusFailure: notActive,
    next: { status: 'Disputed', when: 'always' },
    nextStatus: () => 'Disputed',
  },
  resolve: {
    from: ['Disputed'],
    actor: 'admin',
    actorEnforced: false,
    statusFailure: () => fail(409, 'contract_not_disputed', 'Only disputed contracts can be resolved'),
    guard: (_c, { freelancerBps }) => {
      const bps = Number(freelancerBps);
      return Number.isInteger(bps) && bps >= 0 && bps <= 10000
        ? null
        : fail(400, 'invalid_split', 'freelancerBps must be an integer between 0 and 10000');
    },
    next: { status: 'Resolved', when: 'always' },
    nextStatus: () => 'Resolved',
  },
  cancel: {
    from: ['Created', 'Funded'],
    actor: 'client',
    actorEnforced: false,
    statusFailure: notActive,
    next: { status: 'Cancelled', when: 'always' },
    nextStatus: () => 'Cancelled',
  },
  rate: {
    from: ['Completed'],
    actor: 'client',
    actorEnforced: false,
    statusFailure: () => fail(409, 'contract_not_completed', 'Only completed contracts can issue reputation'),
    guard: (c, { rating: raw }) => {
      if (c.reputationIssued) return fail(409, 'reputation_already_issued', 'Reputation already issued for this contract');
      const rating = Number(raw);
      return Number.isInteger(rating) && rating >= 1 && rating <= 5
        ? null
        : fail(400, 'invalid_rating', 'rating must be an integer from 1 to 5');
    },
    next: { status: 'Completed', when: 'reputation issued' },
    nextStatus: () => 'Completed',
  },
};

export const CHECK_ORDER = ['existence', 'actor', 'status', 'guards'] as const;

/** First failing rule for `action`, or null when it is allowed. Never mutates. */
export function checkAllowed(action: Action, c: MachineContract, args: ActionArgs): GuardFailure | null {
  const rule = TRANSITIONS[action];
  if (rule.actorEnforced && rule.actor === 'party' && args.raisedBy !== c.client && args.raisedBy !== c.freelancer) {
    return fail(403, 'forbidden', 'Only the client or freelancer can open a dispute');
  }
  if (!rule.from.includes(c.status)) return rule.statusFailure(c.status);
  return rule.guard?.(c, args) ?? null;
}

export function assertAllowed(action: Action, c: MachineContract, args: ActionArgs = {}): void {
  const failure = checkAllowed(action, c, args);
  if (failure) throw new HttpError(failure.status, failure.code, failure.reason);
}

export interface AllowedAction {
  action: Action;
  allowed: boolean;
  reason?: string;
  code?: string;
  params?: { index?: number[]; maxDeposit?: string };
}

/**
 * Which actions are possible right now (for `as`, an advisory caller address that
 * only affects the party check on dispute). Uses the same rules as the mutations.
 */
export function allowedActions(c: MachineContract, as?: string): { status: MachineStatus; actions: AllowedAction[] } {
  const actions = (Object.keys(TRANSITIONS) as Action[]).map((action): AllowedAction => {
    const args: ActionArgs = { raisedBy: as, freelancerBps: 5000, rating: 5 };
    let params: AllowedAction['params'];
    if (action === 'deposit') {
      const remaining = c.totalAmount - c.fundedAmount;
      // Probe with the remaining capacity; a full contract is probed with 1 so it reports over_funded.
      args.amount = remaining > 0n ? remaining.toString() : 1;
      params = { maxDeposit: (remaining > 0n ? remaining : 0n).toString() };
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

/** Transition table metadata plus a generated Mermaid state diagram. */
export function describeStateMachine() {
  const transitions = (Object.keys(TRANSITIONS) as Action[]).map((action) => {
    const { from, actor, actorEnforced, next } = TRANSITIONS[action];
    return { action, from, actor, actorEnforced, next };
  });
  const lines = transitions.flatMap(({ action, from, next }) =>
    from.map((status) => `    ${status} --> ${next.status}: ${action}${next.when === 'always' ? '' : ` [${next.when}]`}`),
  );
  // Conditional operations keep their source status until their condition holds.
  for (const { action, from, next } of transitions) {
    if (next.when === 'fully funded' || next.when === 'all milestones released') {
      for (const status of from) if (status !== next.status) lines.push(`    ${status} --> ${status}: ${action} [otherwise]`);
    }
  }
  return { checkOrder: [...CHECK_ORDER], transitions, mermaid: ['stateDiagram-v2', ...lines].join('\n') };
}
