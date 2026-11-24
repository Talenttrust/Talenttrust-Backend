/**
 * Randomized invariant tests for the escrow state machine.
 *
 * A seeded PRNG drives thousands of random actions (deposit, release, dispute,
 * resolve, cancel, rate, edit, extend-deadline, expiry sweeps and clock
 * advances) against an `EscrowStore` with an injected clock. After every step
 * the invariants that mirror the Soroban contract are checked:
 *
 *   - 0 <= releasedAmount <= fundedAmount <= totalAmount for every contract
 *   - terminal states (Completed, Resolved, Cancelled, Expired) reject every
 *     further mutating action and never change; the one exception is the
 *     contract's own `rate` on a Completed contract, allowed once
 *   - `checkAllowed` / `allowedActions` from src/stateMachine.ts agree with
 *     whether the store accepts the action
 *   - successful mutations move funds by exactly the expected amount, and
 *     resolve conserves funds: toFreelancer + toClient == held
 *   - `audit.verify().valid`
 *
 * Runs are deterministic for a seed. Set FUZZ_SEED to replay a seed (or a
 * comma-separated list) and
 * FUZZ_STEPS to change the run length; a failure prints the seed, the step and
 * the last actions taken.
 */
import { AuditStore } from '../src/audit';
import { EscrowContract, EscrowStore, HttpError, StoreInternalState } from '../src/store';
import { Action, ActionArgs, MachineContract, MachineStatus, allowedActions, checkAllowed } from '../src/stateMachine';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TERMINAL = new Set(['Completed', 'Resolved', 'Cancelled', 'Expired']);
const CLIENTS = ['GCLIENTA', 'GCLIENTB'];
const FREELANCERS = ['GFREEA', 'GFREEB'];
const OUTSIDER = 'GOUTSIDER';

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}
type Rng = ReturnType<typeof prng>;

const units = (c: EscrowContract) => ({
  total: BigInt(c.totalAmountUnits),
  funded: BigInt(c.fundedAmountUnits),
  released: BigInt(c.releasedAmountUnits),
});

/** The state machine's view of a public contract. */
function machineView(c: EscrowContract): MachineContract {
  return {
    status: c.status as MachineStatus,
    client: c.client,
    freelancer: c.freelancer,
    milestones: c.milestones.map((m) => ({ index: m.index, amount: BigInt(m.amountUnits), released: m.released })),
    totalAmount: BigInt(c.totalAmountUnits),
    fundedAmount: BigInt(c.fundedAmountUnits),
    releasedAmount: BigInt(c.releasedAmountUnits),
    reputationIssued: c.reputationIssued,
  };
}

/**
 * Cheap assertions for the hot loop (jest's deep equality is too slow to run
 * tens of thousands of times). Failures still carry both values.
 */
function check(cond: boolean, what: string, details?: unknown): void {
  if (!cond) throw new Error(`invariant violated: ${what}${details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`}`);
}
function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  const e = JSON.stringify(expected, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  if (a !== e) throw new Error(`invariant violated: ${what}\nexpected: ${e}\nreceived: ${a}`);
}

/** Outcome of a store call: ok, a domain rejection, or an unexpected crash (always a bug). */
function attempt(fn: () => unknown): { ok: true } | { ok: false; code: string } {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, code: err.code };
    throw new Error(`store threw a non-HttpError: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

/**
 * Audit ring size for the fuzzed store. Small enough that verifying the chain
 * after every step stays cheap, and the ring wraps, so verification of a
 * truncated chain is exercised too.
 */
const AUDIT_RING = 32;
const EMPTY_AUDIT = new AuditStore(AUDIT_RING).toSnapshot();

/**
 * One contract's store state, without the audit log or unrelated reviews: the
 * starting point for throwaway probe stores (other contracts cannot affect its
 * actions, and probes do not need the audit chain).
 */
function probeState(store: EscrowStore, id: number): StoreInternalState {
  const state = store.exportState();
  return {
    ...state,
    contracts: state.contracts.filter((c) => c.id === id),
    reviews: state.reviews.filter((r) => r.contractId === id),
    audit: EMPTY_AUDIT,
  };
}

/** One reusable probe store per clock; reset from a state before every probe. */
const probeStores = new WeakMap<() => Date, EscrowStore>();

/** A fresh copy of `state` sharing the clock, for trying an action without touching the real run. */
function cloneStore(state: StoreInternalState, clock: () => Date): EscrowStore {
  let probe = probeStores.get(clock);
  if (!probe) {
    probe = new EscrowStore(clock);
    probe.audit = new AuditStore(AUDIT_RING); // importState sizes the ring to this, not the config default
    probeStores.set(clock, probe);
  }
  // Only the contract and its reviews are mutated by probes; share the rest.
  probe.importState({ ...state, contracts: structuredClone(state.contracts), reviews: structuredClone(state.reviews) });
  return probe;
}

function newStore(clock: () => Date): EscrowStore {
  const store = new EscrowStore(clock);
  store.audit = new AuditStore(AUDIT_RING);
  return store;
}

type Op =
  | 'create'
  | 'deposit'
  | 'release'
  | 'dispute'
  | 'resolve'
  | 'cancel'
  | 'rate'
  | 'edit'
  | 'extend'
  | 'clock'
  | 'sweep';

const OP_WEIGHTS: Array<[Op, number]> = [
  ['create', 6],
  ['deposit', 18],
  ['release', 16],
  ['dispute', 6],
  ['resolve', 7],
  ['cancel', 4],
  ['rate', 6],
  ['edit', 5],
  ['extend', 6],
  ['clock', 10],
  ['sweep', 3],
];
const OP_TOTAL = OP_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function pickOp(rng: Rng): Op {
  let r = rng.next() * OP_TOTAL;
  for (const [op, w] of OP_WEIGHTS) {
    if ((r -= w) < 0) return op;
  }
  return 'clock';
}

/** Random amount argument: exact remainder, partial, overflow, zero, negative or junk. */
function depositAmount(rng: Rng, c: EscrowContract): unknown {
  const { total, funded } = units(c);
  const remaining = total - funded;
  switch (rng.int(0, 7)) {
    case 0:
    case 1:
      return remaining > 0n ? remaining.toString() : '1';
    case 2:
    case 3:
      return remaining > 1n ? (BigInt(rng.int(1, 1_000_000)) % remaining + 1n).toString() : '1';
    case 4:
      return (remaining + 1n).toString();
    case 5:
      return rng.pick([0, -5, '0']);
    case 6:
      return rng.pick(['abc', 1.5, null, '1e3']);
    default:
      return rng.int(1, 50);
  }
}

function randomMilestones(rng: Rng): number[] {
  return Array.from({ length: rng.int(1, 4) }, () => rng.int(1, 60));
}

interface Ctx {
  store: EscrowStore;
  clock: () => Date;
  rng: Rng;
  ids: number[];
  advance: (ms: number) => void;
  /** Contract states as of the end of the previous step (terminal ones must stay frozen). */
  lastSeen: Map<number, EscrowContract>;
}

const MACHINE_OPS: Partial<Record<Op, Action>> = {
  deposit: 'deposit',
  release: 'release',
  dispute: 'dispute',
  resolve: 'resolve',
  cancel: 'cancel',
  rate: 'rate',
};

/** Apply one random operation; returns a short description for the failure trace. */
function step(ctx: Ctx): string {
  const { store, rng, ids } = ctx;
  let op = pickOp(rng);
  if (op !== 'clock' && op !== 'sweep' && (ids.length === 0 || (op === 'create' && ids.length < 8))) op = 'create';

  if (op === 'create') {
    const client = rng.pick(CLIENTS);
    const c = store.create({
      client,
      freelancer: rng.pick(FREELANCERS),
      milestones: randomMilestones(rng),
      fundingDeadline: rng.chance(0.5) ? new Date(ctx.clock().getTime() + rng.int(2, 72) * HOUR).toISOString() : undefined,
    });
    ids.push(c.id);
    if (ids.length > 12) ids.shift(); // keep the working set small so contracts see long histories
    return `create#${c.id}`;
  }
  if (op === 'clock') {
    const ms = rng.pick([rng.int(1, 59) * 60_000, rng.int(1, 12) * HOUR, rng.int(1, 4) * DAY, 20 * DAY]);
    ctx.advance(ms);
    return `clock+${ms}`;
  }
  if (op === 'sweep') {
    const before = new Map(ids.map((id) => [id, store.get(id)]));
    const expired = store.sweepExpired();
    for (const id of expired) {
      const prev = ctx.lastSeen.get(id) ?? before.get(id);
      const after = store.get(id);
      same(after.status, 'Expired', `sweep expired #${id}`);
      if (prev && prev.status === 'Created') {
        const p = units(prev);
        same(BigInt(after.refundableAmountUnits ?? '0'), p.funded - p.released, `refund on expiry #${id}`);
      }
    }
    same(store.sweepExpired(), [], 'sweepExpired is idempotent');
    return `sweep[${expired.join(',')}]`;
  }

  const id = rng.pick(ids);
  // Reading applies lazy expiry, exactly as every mutation does first.
  const before = store.get(id);
  const view = machineView(before);
  const b = units(before);
  const isTerminal = TERMINAL.has(before.status);
  const asParty = rng.pick([before.client, before.freelancer, OUTSIDER]);

  let args: ActionArgs = {};
  let call: () => unknown;
  switch (op) {
    case 'deposit': {
      const amount = depositAmount(rng, before);
      args = { amount };
      call = () => store.deposit(id, amount);
      break;
    }
    case 'release': {
      const index = rng.chance(0.9) ? rng.int(0, before.milestones.length - 1) : rng.pick([before.milestones.length, 99]);
      args = { index };
      call = () => store.release(id, index);
      break;
    }
    case 'dispute': {
      args = { raisedBy: asParty };
      call = () => store.openDispute(id, asParty, 'fuzz');
      break;
    }
    case 'resolve': {
      const bps = rng.chance(0.85) ? rng.pick([0, 1, 3333, 5000, 9999, 10000, rng.int(0, 10000)]) : rng.pick([-1, 10001, 2.5, 'x']);
      args = { freelancerBps: bps };
      call = () => store.resolveDispute(id, bps);
      break;
    }
    case 'cancel':
      call = () => store.cancel(id);
      break;
    case 'rate': {
      const rating = rng.chance(0.85) ? rng.int(1, 5) : rng.pick([0, 6, 2.5]);
      args = { rating };
      call = () => store.rate(id, rating);
      break;
    }
    case 'edit': {
      const editor = rng.chance(0.9) ? before.client : before.freelancer;
      const patch = rng.chance(0.5) ? { milestones: randomMilestones(rng) } : { title: `t${rng.int(1, 99)}` };
      call = () => store.edit(id, { client: editor, ...patch });
      break;
    }
    case 'extend': {
      const by = rng.chance(0.9) ? before.client : before.freelancer;
      const deadline = new Date(Date.parse(before.fundingDeadline) + rng.pick([-HOUR, rng.int(1, 10) * DAY, 120 * DAY])).toISOString();
      call = () => store.extendDeadline(id, by, deadline);
      break;
    }
    default:
      throw new Error(`unhandled op ${op}`);
  }

  const result = attempt(call);
  const after = store.get(id);
  const a = units(after);
  const label = `${op}#${id}(${before.status},${JSON.stringify(args)})=${result.ok ? 'ok' : result.code}`;

  // The state machine and the store agree on every machine action with these exact args.
  const action = MACHINE_OPS[op];
  if (action) {
    const expected = checkAllowed(action, view, args);
    same(result.ok ? 'ok' : result.code, expected === null ? 'ok' : expected.code, `checkAllowed vs store for ${label}`);
  }

  // Terminal states reject every mutating action and never change (contract-level
  // `rate` on a not-yet-rated Completed contract is the one allowed transition).
  const rateAllowed = op === 'rate' && before.status === 'Completed' && !before.reputationIssued;
  if (isTerminal && !rateAllowed) {
    check(!result.ok, `terminal state accepted a mutation: ${label}`);
    same(after, before, `terminal contract changed: ${label}`);
  }
  if (isTerminal) same(after.status, before.status, `terminal status changed: ${label}`);

  if (!result.ok) {
    same(after, before, `rejected action changed the contract: ${label}`);
    return label;
  }

  // Successful mutations move funds by exactly the expected amount.
  switch (op) {
    case 'deposit':
      same(a.funded - b.funded, BigInt(String(args.amount)), `deposit delta: ${label}`);
      same(a.released, b.released, `deposit left released alone: ${label}`);
      same(after.status, a.funded === a.total ? 'Funded' : before.status, `deposit status: ${label}`);
      break;
    case 'release': {
      const m = before.milestones[args.index as number];
      same(a.released - b.released, BigInt(m.amountUnits), `release delta: ${label}`);
      same(a.funded, b.funded, `release left funded alone: ${label}`);
      same(after.milestones[args.index as number].released, true, `milestone marked released: ${label}`);
      same(after.status, after.milestones.every((x) => x.released) ? 'Completed' : before.status, `release status: ${label}`);
      break;
    }
    case 'resolve': {
      const held = b.funded - b.released;
      const toFreelancer = a.released - b.released;
      const toClient = held - toFreelancer;
      same(after.status, 'Resolved', `resolve status: ${label}`);
      same(a.funded, b.funded, `resolve left funded alone: ${label}`);
      same(toFreelancer, (held * BigInt(Number(args.freelancerBps))) / 10000n, `resolve split: ${label}`);
      check(toFreelancer >= 0n && toClient >= 0n, `resolve split is non-negative: ${label}`);
      const entry = store.audit.getContractHistory(id, 1000).data.filter((e) => e.action === 'resolve').at(-1);
      same(BigInt(String(entry?.details.toFreelancerUnits)) + BigInt(String(entry?.details.toClientUnits)), held, `resolve conserves funds: ${label}`);
      break;
    }
    case 'dispute':
      same(after.status, 'Disputed', `dispute status: ${label}`);
      same(a, b, `dispute moved no funds: ${label}`);
      break;
    case 'cancel':
      same(after.status, 'Cancelled', `cancel status: ${label}`);
      same(a, b, `cancel moved no funds: ${label}`);
      break;
    case 'rate':
      same(after.reputationIssued, true, `rate issued reputation: ${label}`);
      same(a, b, `rate moved no funds: ${label}`);
      break;
    case 'edit':
      same(before.status, 'Created', `edit only before funding: ${label}`);
      same(b.funded, 0n, `edit only before funding: ${label}`);
      break;
    case 'extend':
      check(Date.parse(after.fundingDeadline) > Date.parse(before.fundingDeadline), `extend moved the deadline later: ${label}`);
      same(a, b, `extend moved no funds: ${label}`);
      break;
  }
  return label;
}

/** allowedActions() matches what the store does when each probed action is actually tried. */
function checkAllowedActionsAgree(ctx: Ctx, id: number) {
  const { store } = ctx;
  const c = store.get(id);
  const report = store.allowedActions(id, c.client);
  const base = probeState(store, id);
  const remaining = units(c).total - units(c).funded;
  for (const entry of report.actions) {
    const probe = () => cloneStore(base, ctx.clock);
    const tries: Array<() => unknown> = [];
    switch (entry.action) {
      case 'deposit':
        tries.push(() => probe().deposit(id, remaining > 0n ? remaining.toString() : 1));
        break;
      case 'release': {
        const indexes = entry.params?.index ?? [];
        for (const m of c.milestones) {
          const expectOk = indexes.includes(m.index);
          const r = attempt(() => cloneStore(base, ctx.clock).release(id, m.index));
          same(r.ok, expectOk, `allowedActions release index ${m.index} on #${id} (${c.status})`);
        }
        if (indexes.length) tries.push(() => probe().release(id, indexes[0]));
        else continue;
        break;
      }
      case 'dispute':
        tries.push(() => probe().openDispute(id, c.client, 'probe'));
        break;
      case 'resolve':
        tries.push(() => probe().resolveDispute(id, 5000));
        break;
      case 'cancel':
        tries.push(() => probe().cancel(id));
        break;
      case 'rate':
        tries.push(() => probe().rate(id, 5));
        break;
    }
    for (const t of tries) {
      const r = attempt(t);
      same(r.ok ? 'ok' : r.code, entry.allowed ? 'ok' : entry.code, `allowedActions ${entry.action} on #${id} (${c.status})`);
    }
  }
  // The store's report is the pure state-machine function of the same contract.
  same(report, allowedActions(machineView(c), c.client), `store allowedActions matches the state machine for #${id}`);
}

function checkGlobalInvariants(ctx: Ctx) {
  for (const id of ctx.ids) {
    const c = ctx.store.get(id);
    const { total, funded, released } = units(c);
    check(0n <= released && released <= funded && funded <= total, `0 <= released <= funded <= total for #${id}`, { total, funded, released });
    const releasedSum = c.milestones.filter((m) => m.released).reduce((s, m) => s + BigInt(m.amountUnits), 0n);
    if (c.status !== 'Resolved') same(released, releasedSum, `released equals released milestones for #${id}`);

    const prev = ctx.lastSeen.get(id);
    if (prev && TERMINAL.has(prev.status)) {
      same(c.status, prev.status, `terminal status of #${id} changed`);
      if (!(prev.status === 'Completed' && !prev.reputationIssued)) same(c, prev, `terminal contract #${id} changed`);
    }
    ctx.lastSeen.set(id, c);
  }
  const verify = ctx.store.audit.verify();
  check(verify.valid, 'audit.verify().valid', verify);
}

function runFuzz(seed: number, steps: number) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const ctx: Ctx = {
    store: newStore(clock),
    clock,
    rng: prng(seed),
    ids: [],
    advance: (ms) => {
      now += ms;
    },
    lastSeen: new Map(),
  };
  const trace: string[] = [];
  const stats: Record<string, number> = {};
  for (let i = 0; i < steps; i++) {
    try {
      const label = step(ctx);
      trace.push(label);
      if (trace.length > 25) trace.shift();
      const kind = label.split(/[#(+[]/)[0];
      stats[kind] = (stats[kind] ?? 0) + 1;
      if (/^(deposit|release|dispute|resolve|cancel|rate|edit|extend)#/.test(label)) {
        const id = Number(label.split('#')[1].split('(')[0]);
        checkAllowedActionsAgree(ctx, id);
      }
      checkGlobalInvariants(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `state-machine fuzz failed: seed=${seed} step=${i} (replay with FUZZ_SEED=${seed})\n` +
          `last actions:\n  ${trace.join('\n  ')}\n\n${message}`,
      );
    }
  }
  const statuses = new Set(ctx.ids.map((id) => ctx.store.get(id).status));
  return { stats, statuses };
}

const STEPS = Number(process.env.FUZZ_STEPS ?? 2000);
const SEEDS = process.env.FUZZ_SEED ? process.env.FUZZ_SEED.split(',').map(Number) : [1, 42, 20260101];

describe('escrow state machine — randomized invariants', () => {
  it.each(SEEDS)('holds every invariant for seed %i', (seed) => {
    const { stats } = runFuzz(seed, STEPS);
    // Guard against a fuzzer that silently stops exercising an operation.
    for (const op of ['create', 'deposit', 'release', 'dispute', 'resolve', 'cancel', 'rate', 'edit', 'extend', 'clock']) {
      expect({ op, seen: (stats[op] ?? 0) > 0 }).toEqual({ op, seen: true });
    }
  });

  it('is deterministic for a given seed', () => {
    const a = runFuzz(99, 400);
    const b = runFuzz(99, 400);
    expect(a.stats).toEqual(b.stats);
    expect([...a.statuses].sort()).toEqual([...b.statuses].sort());
  });

  it('reaches every status across the seeded runs', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      let now = Date.parse('2026-01-01T00:00:00.000Z');
      const clock = () => new Date(now);
      const store = newStore(clock);
      const ctx: Ctx = { store, clock, rng: prng(seed), ids: [], advance: (ms) => (now += ms), lastSeen: new Map() };
      for (let i = 0; i < 800; i++) {
        step(ctx);
        for (const c of store.list()) seen.add(c.status);
      }
    }
    expect([...seen].sort()).toEqual(['Cancelled', 'Completed', 'Created', 'Disputed', 'Expired', 'Funded', 'Resolved']);
  });
});
