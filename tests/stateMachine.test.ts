import request from 'supertest';
import { createApp } from '../src/app';
import { ContractStatus, EscrowStore, HttpError } from '../src/store';
import { Action, AllowedAction, describeStateMachine } from '../src/stateMachine';

const statuses: ContractStatus[] = ['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'];
const actions: Action[] = ['deposit', 'release', 'dispute', 'resolve', 'cancel', 'rate'];
// Admin is an advisory address, not an authenticated role in the existing API.
const callers = { client: 'GC', freelancer: 'GF', admin: 'GADMIN', outsider: 'GX', anonymous: undefined };
const from: Record<Action, ContractStatus[]> = {
  deposit: ['Created', 'Funded'], release: ['Created', 'Funded'], dispute: ['Created', 'Funded'],
  resolve: ['Disputed'], cancel: ['Created', 'Funded'], rate: ['Completed'],
};
function fixture(status: ContractStatus = 'Created') {
  const store = new EscrowStore();
  const c = store.create({ client: 'GC', freelancer: 'GF', milestones: [10, 20] });
  store.deposit(c.id, 15);
  c.status = status; // Exercise every status with otherwise valid guard inputs.
  return { store, c, app: createApp(store) };
}
function mutate(store: EscrowStore, id: number, action: Action, as?: string) {
  switch (action) {
    case 'deposit': return store.deposit(id, 1);
    case 'release': return store.release(id, 0);
    case 'dispute': return store.openDispute(id, as, 'test');
    case 'resolve': return store.resolveDispute(id, 5000);
    case 'cancel': return store.cancel(id);
    case 'rate': return store.rate(id, 5);
  }
}

describe('state machine and action discovery', () => {
  const cases = statuses.flatMap((status) => actions.flatMap((action) =>
    Object.entries(callers).map(([role, as]) => ({ status, action, role, as }))));
  test.each(cases)('$status / $action / $role: discovery matches store', async ({ status, action, as }) => {
    const { store, c, app } = fixture(status);
    const before = JSON.stringify(c);
    const response = await request(app).get(`/api/v1/contracts/${c.id}/actions`).query(as ? { as } : {}).expect(200);
    expect(JSON.stringify(c)).toBe(before);
    const result: AllowedAction = response.body.actions.find((a: AllowedAction) => a.action === action);
    const expected = from[action].includes(status) && (action !== 'dispute' || as === 'GC' || as === 'GF');
    expect(result.allowed).toBe(expected);
    if (expected) expect(() => mutate(store, c.id, action, as)).not.toThrow();
    else {
      try { mutate(store, c.id, action, as); throw new Error('Unexpected success'); }
      catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).code).toBe(result.code);
        expect((error as HttpError).status).toBe(from[action].includes(status) ? 403 : 409);
      }
      expect(JSON.stringify(c)).toBe(before);
    }
  });

  test('seeded contract lists remaining release indexes and blocks further funding', async () => {
    const app = createApp(new EscrowStore().seed());
    const { body } = await request(app).get('/api/v1/contracts/1/actions').query({ as: 'GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }).expect(200);
    expect(body.status).toBe('Funded');
    expect(body.actions).toContainEqual({ action: 'release', allowed: true, params: { index: [1, 2] } });
    expect(body.actions).toContainEqual({ action: 'deposit', allowed: false, code: 'over_funded', reason: 'deposit exceeds contract total', params: { maxDeposit: 0 } });
  });

  test('guards and next statuses follow funding, releases and reputation without discovery mutation', async () => {
    const { app, store, c } = fixture();
    let res = await request(app).get('/api/v1/contracts/1/actions').expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'release').params.index).toEqual([0]);
    store.release(c.id, 0);
    res = await request(app).get('/api/v1/contracts/1/actions').expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'release')).toMatchObject({ allowed: false, code: 'insufficient_funds', params: { index: [] } });
    store.deposit(c.id, 15);
    expect(c.status).toBe('Funded');
    store.release(c.id, 1);
    expect(c.status).toBe('Completed');
    store.rate(c.id, 4);
    res = await request(app).get('/api/v1/contracts/1/actions').expect(200);
    expect(res.body.actions.find((a: AllowedAction) => a.action === 'rate')).toMatchObject({ allowed: false, code: 'reputation_already_issued' });
    expect(() => store.rate(c.id, 5)).toThrow('Reputation already issued');
  });

  test('preserves decimal and exact large integer funding', async () => {
    for (const amount of [0.5, '900719925474099312345']) {
      const store = new EscrowStore();
      const c = store.create({ client: 'GC', freelancer: 'GF', milestones: [amount] });
      const { body } = await request(createApp(store)).get('/api/v1/contracts/1/actions').expect(200);
      expect(body.actions.find((a: AllowedAction) => a.action === 'deposit').params.maxDeposit).toBe(amount);
      store.deposit(c.id, amount);
      expect(c.status).toBe('Funded');
      store.release(c.id, 0);
      expect(c.status).toBe('Completed');
      expect(c.releasedAmount).toBe(amount);
    }
  });

  test.each([
    ['deposit', { amount: 0 }, 400, 'invalid_amount'],
    ['deposit', { amount: 100 }, 409, 'over_funded'],
    ['milestones/99/release', {}, 404, 'milestone_not_found'],
    ['milestones/1/release', {}, 409, 'insufficient_funds'],
    ['dispute', { raisedBy: 'GX' }, 403, 'unauthorized'],
  ] as const)('preserves %s guard errors', async (route, body, status, code) => {
    const { app, c } = fixture();
    const before = JSON.stringify(c);
    const response = await request(app).post(`/api/v1/contracts/1/${route}`).send(body).expect(status);
    expect(response.body.error).toBe(code);
    expect(JSON.stringify(c)).toBe(before);
  });

  test('existence precedes status, which precedes actor and guards', async () => {
    const { app } = fixture('Cancelled');
    expect((await request(app).post('/api/v1/contracts/999/dispute').send({ raisedBy: 'GX' }).expect(404)).body.error).toBe('contract_not_found');
    expect((await request(app).post('/api/v1/contracts/1/dispute').send({ raisedBy: 'GX' }).expect(409)).body.error).toBe('invalid_status');
    expect((await request(app).post('/api/v1/contracts/1/deposit').send({ amount: -1 }).expect(409)).body.error).toBe('invalid_status');
  });

  test('keeps split, rating, duplicate release and bigint input errors', () => {
    const { store, c } = fixture('Disputed');
    expect(() => store.resolveDispute(c.id, 10001)).toThrow('freelancerBps must be an integer');
    c.status = 'Completed';
    expect(() => store.rate(c.id, 6)).toThrow('rating must be an integer');
    c.status = 'Created';
    store.release(c.id, 0);
    expect(() => store.release(c.id, 0)).toThrow('Milestone already released');
    const big = store.create({ client: 'GC', freelancer: 'GF', milestones: ['100'] });
    for (const amount of ['no', '0', '-1', '1.5']) {
      expect(() => store.deposit(big.id, amount)).toThrow('amount must be positive');
    }
    expect(() => store.deposit(big.id, '101')).toThrow('deposit exceeds contract total');
  });

  test('validates discovery inputs and documents endpoints', async () => {
    const { app } = fixture();
    await request(app).get('/api/v1/contracts/no/actions').expect(400);
    await request(app).get('/api/v1/contracts/999/actions').expect(404);
    for (const query of ['as=', 'as=a&as=b', 'as[x]=a']) {
      expect((await request(app).get(`/api/v1/contracts/1/actions?${query}`).expect(400)).body.error).toBe('invalid_actor');
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
    expect(body.transitions).toHaveLength(6);
    expect(body.transitions.filter((t: { actorEnforced: boolean }) => t.actorEnforced).map((t: { action: string }) => t.action)).toEqual(['dispute']);
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
