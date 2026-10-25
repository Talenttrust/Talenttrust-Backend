import request from 'supertest';
import { createApp } from '../src/app';
import { ContractStatus, EscrowStore, HttpError } from '../src/store';
import { Action, AllowedAction, describeStateMachine } from '../src/stateMachine';

const actions: Action[] = ['deposit', 'release', 'dispute', 'resolve', 'cancel', 'rate'];
// Advisory callers: only the dispute party check looks at `as`.
const callers = { client: 'GC', freelancer: 'GF', outsider: 'GX', anonymous: undefined };
const DAY = 24 * 60 * 60 * 1000;

/**
 * A contract (milestones 10 + 20) driven to `status` through real transitions;
 * the store hands out copies, so state can only be reached this way.
 */
function fixture(status: ContractStatus = 'Created') {
  let now = Date.now();
  const store = new EscrowStore(() => new Date(now));
  const c = store.create({ client: 'GC', freelancer: 'GF', milestones: [10, 20] });
  switch (status) {
    case 'Created':
      store.deposit(c.id, 15);
      break;
    case 'Funded':
      store.deposit(c.id, 30);
      break;
    case 'Completed':
      store.deposit(c.id, 30);
      store.release(c.id, 0);
      store.release(c.id, 1);
      break;
    case 'Disputed':
      store.deposit(c.id, 15);
      store.openDispute(c.id, 'GC', 'late');
      break;
    case 'Resolved':
      store.deposit(c.id, 15);
      store.openDispute(c.id, 'GC', 'late');
      store.resolveDispute(c.id, 5000);
      break;
    case 'Cancelled':
      store.cancel(c.id);
      break;
    case 'Expired':
      now += 15 * DAY; // past the default 14-day funding deadline
      break;
  }
  expect(store.get(c.id).status).toBe(status);
  return { store, id: c.id, app: createApp(store) };
}

/** Run `action` with the same arguments discovery probed with. */
function mutate(store: EscrowStore, id: number, action: Action, discovered: AllowedAction, as?: string) {
  switch (action) {
    case 'deposit': {
      const max = discovered.params?.maxDeposit ?? '0';
      return store.deposit(id, max === '0' ? 1 : max);
    }
    case 'release': {
      const c = store.get(id);
      const index = discovered.params?.index?.[0] ?? c.milestones.find((m) => !m.released)?.index ?? 0;
      return store.release(id, index);
    }
    case 'dispute':
      return store.openDispute(id, as, 'test');
    case 'resolve':
      return store.resolveDispute(id, 5000);
    case 'cancel':
      return store.cancel(id);
    case 'rate':
      return store.rate(id, 5);
  }
}

const statuses: ContractStatus[] = ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled', 'Expired'];

describe('state machine and action discovery', () => {
  const cases = statuses.flatMap((status) =>
    actions.flatMap((action) => Object.entries(callers).map(([role, as]) => ({ status, action, role, as }))),
  );

  test.each(cases)('$status / $action / $role: discovery matches the store', async ({ status, action, as }) => {
    const { store, id, app } = fixture(status);
    const before = JSON.stringify(store.get(id));
    const response = await request(app)
      .get(`/api/v1/contracts/${id}/actions`)
      .query(as ? { as } : {})
      .expect(200);
    expect(JSON.stringify(store.get(id))).toBe(before); // discovery never mutates
    expect(response.body.status).toBe(status);
    const result: AllowedAction = response.body.actions.find((a: AllowedAction) => a.action === action);
    if (result.allowed) {
      expect(() => mutate(store, id, action, result, as)).not.toThrow();
    } else {
      let thrown: unknown;
      try {
        mutate(store, id, action, result, as);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).code).toBe(result.code);
      expect(JSON.stringify(store.get(id))).toBe(before); // rejected mutations change nothing
    }
  });

  test('allowed actions per status follow the transition table', async () => {
    const allowed = async (status: ContractStatus) => {
      const { app, id } = fixture(status);
      const { body } = await request(app).get(`/api/v1/contracts/${id}/actions`).query({ as: 'GC' }).expect(200);
      return body.actions.filter((a: AllowedAction) => a.allowed).map((a: AllowedAction) => a.action);
    };
    expect(await allowed('Created')).toEqual(['deposit', 'release', 'dispute', 'cancel']);
    expect(await allowed('Funded')).toEqual(['release', 'dispute', 'cancel']); // fully funded: no more deposits
    expect(await allowed('Completed')).toEqual(['rate']);
    expect(await allowed('Disputed')).toEqual(['resolve']);
    expect(await allowed('Resolved')).toEqual([]);
    expect(await allowed('Cancelled')).toEqual([]);
    expect(await allowed('Expired')).toEqual([]);
  });

  test('seeded contract lists remaining release indexes and blocks further funding', async () => {
    const app = createApp(new EscrowStore().seed());
    const { body } = await request(app)
      .get('/api/v1/contracts/1/actions')
      .query({ as: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
      .expect(200);
    expect(body.status).toBe('Funded');
    expect(body.actions).toContainEqual({ action: 'release', allowed: true, params: { index: [1, 2] } });
    expect(body.actions).toContainEqual({
      action: 'deposit',
      allowed: false,
      code: 'over_funded',
      reason: 'deposit exceeds contract total',
      params: { maxDeposit: '0' },
    });
  });

  test('guards and next statuses follow funding, releases and reputation', async () => {
    const { app, store, id } = fixture();
    let res = await request(app).get(`/api/v1/contracts/${id}/actions`).expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'release').params.index).toEqual([0]);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'deposit').params.maxDeposit).toBe('15');
    store.release(id, 0);
    res = await request(app).get(`/api/v1/contracts/${id}/actions`).expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'release')).toMatchObject({
      allowed: false,
      code: 'insufficient_funds',
      params: { index: [] },
    });
    store.deposit(id, 15);
    expect(store.get(id).status).toBe('Funded');
    store.release(id, 1);
    expect(store.get(id).status).toBe('Completed');
    store.rate(id, 4);
    res = await request(app).get(`/api/v1/contracts/${id}/actions`).expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'rate')).toMatchObject({
      allowed: false,
      code: 'reputation_already_issued',
    });
    expect(() => store.rate(id, 5)).toThrow('Reputation already issued');
  });

  test('reports exact remaining capacity for large integer amounts', async () => {
    const store = new EscrowStore();
    const c = store.create({ client: 'GC', freelancer: 'GF', milestones: ['900719925474099312345'] });
    const { body } = await request(createApp(store)).get(`/api/v1/contracts/${c.id}/actions`).expect(200);
    expect(body.actions.find((a: AllowedAction) => a.action === 'deposit').params.maxDeposit).toBe('900719925474099312345');
    store.deposit(c.id, '900719925474099312345');
    expect(store.get(c.id).status).toBe('Funded');
    store.release(c.id, 0);
    expect(store.get(c.id).status).toBe('Completed');
    expect(store.get(c.id).releasedAmountUnits).toBe('900719925474099312345');
  });

  test.each([
    ['deposit', { amount: 0 }, 400, 'invalid_amount'],
    ['deposit', { amount: 100 }, 409, 'over_funded'],
    ['milestones/19/release', {}, 404, 'milestone_not_found'],
    ['milestones/1/release', {}, 409, 'insufficient_funds'],
    ['dispute', { raisedBy: 'GX' }, 403, 'forbidden'],
  ] as const)('preserves %s guard errors', async (route, body, status, code) => {
    const { app, store, id } = fixture();
    const before = JSON.stringify(store.get(id));
    const response = await request(app).post(`/api/v1/contracts/${id}/${route}`).send(body).expect(status);
    expect(response.body.error).toBe(code);
    expect(JSON.stringify(store.get(id))).toBe(before);
  });

  test('existence precedes actor, which precedes status and guards', async () => {
    const { app, id } = fixture('Cancelled');
    expect((await request(app).post('/api/v1/contracts/999/dispute').send({ raisedBy: 'GX' }).expect(404)).body.error).toBe(
      'contract_not_found',
    );
    expect((await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GX' }).expect(403)).body.error).toBe(
      'forbidden',
    );
    expect((await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GC' }).expect(409)).body.error).toBe(
      'contract_not_active',
    );
    expect((await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1 }).expect(409)).body.error).toBe(
      'contract_not_active',
    );
  });

  test('keeps split, rating, duplicate release and amount errors', () => {
    const disputed = fixture('Disputed');
    expect(() => disputed.store.resolveDispute(disputed.id, 10001)).toThrow('freelancerBps must be an integer');
    const completed = fixture('Completed');
    expect(() => completed.store.rate(completed.id, 6)).toThrow('rating must be an integer');
    const created = fixture('Created');
    created.store.release(created.id, 0);
    expect(() => created.store.release(created.id, 0)).toThrow('Milestone already released');
    const big = created.store.create({ client: 'GC', freelancer: 'GF', milestones: ['100'] });
    for (const amount of ['no', '0', '-1', '1.5']) {
      expect(() => created.store.deposit(big.id, amount)).toThrow(/amount/);
    }
    expect(() => created.store.deposit(big.id, '101')).toThrow('deposit exceeds contract total');
  });

  test('validates discovery inputs and documents endpoints', async () => {
    const { app, id } = fixture();
    await request(app).get('/api/v1/contracts/no/actions').expect(400);
    await request(app).get('/api/v1/contracts/999/actions').expect(404);
    for (const query of ['as=', 'as=a&as=b', 'as[x]=a']) {
      expect((await request(app).get(`/api/v1/contracts/${id}/actions?${query}`).expect(400)).body.error).toBe('invalid_actor');
    }
    const { body } = await request(app).get('/openapi.json').expect(200);
    expect(body.openapi).toBe('3.0.3');
    for (const path of ['/api/v1/contracts/{id}/actions', '/api/v1/state-machine']) {
      expect(body.paths[path].get.responses['200'].content['application/json'].schema).toBeDefined();
    }
  });

  test('serializes table metadata and a generated Mermaid snapshot', async () => {
    const { app } = fixture();
    const { body } = await request(app).get('/api/v1/state-machine').expect(200);
    expect(body).toEqual(describeStateMachine());
    expect(body.checkOrder).toEqual(['existence', 'actor', 'status', 'guards']);
    expect(body.transitions).toHaveLength(6);
    expect(body.transitions.filter((t: { actorEnforced: boolean }) => t.actorEnforced).map((t: { action: string }) => t.action)).toEqual([
      'dispute',
    ]);
    expect(body.mermaid).toMatchInlineSnapshot(`
"stateDiagram-v2
    Created --> Funded: deposit [fully funded]
    Funded --> Funded: deposit [fully funded]
    Created --> Completed: release [all milestones released]
    Funded --> Completed: release [all milestones released]
    Created --> Disputed: dispute
    Funded --> Disputed: dispute
    Disputed --> Resolved: resolve
    Created --> Cancelled: cancel
    Funded --> Cancelled: cancel
    Completed --> Completed: rate [reputation issued]
    Created --> Created: deposit [otherwise]
    Created --> Created: release [otherwise]
    Funded --> Funded: release [otherwise]"
`);
  });
});
