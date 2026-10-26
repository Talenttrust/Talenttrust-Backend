import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { account } from './helpers/addresses';

describe('Milestone Templates', () => {
  const templateApp = createApp(new EscrowStore());

  it('creates a fixed mode template', async () => {
    const res = await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Web Build Fixed',
        mode: 'fixed',
        milestones: [{ title: 'Design', amount: 500 }, { title: 'Build', amount: 1000 }],
      })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.owner).toBe('GOWNER');
    expect(res.body.name).toBe('Web Build Fixed');
    expect(res.body.mode).toBe('fixed');
    expect(res.body.milestones).toHaveLength(2);
    expect(res.body.version).toBe(1);
  });

  it('creates a percent mode template', async () => {
    const res = await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Web Build Percent',
        mode: 'percent',
        milestones: [{ title: 'Design', percentBps: 3000 }, { title: 'Build', percentBps: 7000 }],
      })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.mode).toBe('percent');
    expect(res.body.milestones[0].percentBps).toBe(3000);
    expect(res.body.milestones[1].percentBps).toBe(7000);
  });

  it('rejects percent template with bps not summing to 10000', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Bad Percent',
        mode: 'percent',
        milestones: [{ title: 'Design', percentBps: 3000 }, { title: 'Build', percentBps: 6000 }],
      })
      .expect(400);
  });

  it('rejects mixed amount/percentBps in fixed mode', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Mixed',
        mode: 'fixed',
        milestones: [{ title: 'Design', amount: 500 }, { title: 'Build', percentBps: 7000 }],
      })
      .expect(400);
  });

  it('rejects mixed amount/percentBps in percent mode', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Mixed',
        mode: 'percent',
        milestones: [{ title: 'Design', percentBps: 3000 }, { title: 'Build', amount: 1000 }],
      })
      .expect(400);
  });

  it('rejects more than 20 milestones', async () => {
    const milestones = Array(21).fill({ title: 'M', amount: 100 });
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Too Many', mode: 'fixed', milestones })
      .expect(400);
  });

  it('rejects name longer than 80 chars', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'a'.repeat(81), mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(400);
  });

  it('rejects description longer than 500 chars', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Test', description: 'a'.repeat(501), mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(400);
  });

  it('lists templates by owner', async () => {
    const t1 = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER1', name: 'T1', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER2', name: 'T2', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    const list = await request(templateApp)
      .get('/api/v1/templates?owner=GOWNER1')
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(t1.body.id);
  });

  it('gets a template by id', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Get Me', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    const res = await request(templateApp).get(`/api/v1/templates/${created.body.id}`).expect(200);
    expect(res.body.name).toBe('Get Me');
  });

  it('updates a template (owner only)', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Original', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .put(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GOWNER', name: 'Updated', description: 'New desc' })
      .expect(200);
    const res = await request(templateApp).get(`/api/v1/templates/${created.body.id}`).expect(200);
    expect(res.body.name).toBe('Updated');
    expect(res.body.description).toBe('New desc');
    expect(res.body.version).toBe(2);
  });

  it('rejects update by non-owner', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Original', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .put(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GOTHER', name: 'Hacked' })
      .expect(403);
  });

  it('rejects update with invalid percent bps sum', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'Original', mode: 'percent', milestones: [{ percentBps: 5000 }, { percentBps: 5000 }] })
      .expect(201);
    await request(templateApp)
      .put(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GOWNER', milestones: [{ percentBps: 3000 }, { percentBps: 3000 }] })
      .expect(400);
  });

  it('deletes a template (owner only)', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'To Delete', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .delete(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GOWNER' })
      .expect(200);
    await request(templateApp).get(`/api/v1/templates/${created.body.id}`).expect(404);
  });

  it('rejects delete by non-owner', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'To Delete', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .delete(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GOTHER' })
      .expect(403);
  });

  it('creating contract from fixed template produces identical milestones', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Fixed Template',
        mode: 'fixed',
        milestones: [{ title: 'Design', amount: 500 }, { title: 'Build', amount: 1000 }],
      })
      .expect(201);
    const contract = await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GCLIENT'), freelancer: account('GFREELANCER'), templateId: template.body.id })
      .expect(201);
    expect(contract.body.milestones).toHaveLength(2);
    expect(contract.body.milestones[0].title).toBe('Design');
    expect(contract.body.milestones[0].amount).toBe(500);
    expect(contract.body.milestones[1].title).toBe('Build');
    expect(contract.body.milestones[1].amount).toBe(1000);
    expect(contract.body.totalAmount).toBe(1500);
    expect(contract.body.templateId).toBe(template.body.id);
    expect(contract.body.templateVersion).toBe(1);
  });

  it('creating contract from percent template with budget 1001 and 3333/3333/3334 bps sums to 1001 with remainder on last', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({
        owner: 'GOWNER',
        name: 'Percent Template',
        mode: 'percent',
        milestones: [
          { title: 'Phase 1', percentBps: 3333 },
          { title: 'Phase 2', percentBps: 3333 },
          { title: 'Phase 3', percentBps: 3334 },
        ],
      })
      .expect(201);
    const contract = await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GCLIENT'), freelancer: account('GFREELANCER'), templateId: template.body.id, budget: 1001 })
      .expect(201);
    expect(contract.body.milestones).toHaveLength(3);
    const amounts = contract.body.milestones.map((m: { amount: number }) => m.amount);
    expect(amounts[0]).toBe(333);
    expect(amounts[1]).toBe(333);
    expect(amounts[2]).toBe(335);
    expect(amounts.reduce((a: number, b: number) => a + b, 0)).toBe(1001);
    expect(contract.body.totalAmount).toBe(1001);
    expect(contract.body.templateId).toBe(template.body.id);
    expect(contract.body.templateVersion).toBe(1);
  });

  it('rejects contract creation with both templateId and milestones', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'T', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), templateId: template.body.id, milestones: [{ amount: 100 }] })
      .expect(400);
  });

  it('rejects contract creation with percent template but no budget', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'T', mode: 'percent', milestones: [{ percentBps: 10000 }] })
      .expect(201);
    await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), templateId: template.body.id })
      .expect(400);
  });

  it('rejects contract creation with fixed template and budget', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'T', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), templateId: template.body.id, budget: 1000 })
      .expect(400);
  });

  it('rejects contract creation with neither templateId nor milestones', async () => {
    await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB') })
      .expect(400);
  });

  it('deleting a template does not affect contracts already created from it', async () => {
    const template = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GOWNER', name: 'T', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    const contract = await request(templateApp)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), templateId: template.body.id })
      .expect(201);
    await request(templateApp)
      .delete(`/api/v1/templates/${template.body.id}`)
      .send({ owner: 'GOWNER' })
      .expect(200);
    const existingContract = await request(templateApp).get(`/api/v1/contracts/${contract.body.id}`).expect(200);
    expect(existingContract.body.milestones[0].amount).toBe(100);
  });

  it('validates template id path params', async () => {
    await request(templateApp).get('/api/v1/templates/0x1').expect(400);
    await request(templateApp).get('/api/v1/templates/0').expect(400);
    await request(templateApp).get('/api/v1/templates/-1').expect(400);
    await request(templateApp).put('/api/v1/templates/abc').send({ owner: 'GA' }).expect(400);
    await request(templateApp).delete('/api/v1/templates/1e0').send({ owner: 'GA' }).expect(400);
  });

  it('rejects unknown body keys in template endpoints', async () => {
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GA', name: 'T', mode: 'fixed', milestones: [{ amount: 1 }], foo: 1 })
      .expect(400);
  });

  it('validates template boundary values', async () => {
    const title80 = 'a'.repeat(80);
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GA', name: title80, mode: 'fixed', milestones: [{ amount: 1 }] })
      .expect(201);
    const desc500 = 'a'.repeat(500);
    await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GA', name: 'T', description: desc500, mode: 'fixed', milestones: [{ amount: 1 }] })
      .expect(201);
  });

  it('update template can change mode and milestones', async () => {
    const created = await request(templateApp)
      .post('/api/v1/templates')
      .send({ owner: 'GA', name: 'T', mode: 'fixed', milestones: [{ amount: 100 }] })
      .expect(201);
    await request(templateApp)
      .put(`/api/v1/templates/${created.body.id}`)
      .send({ owner: 'GA', mode: 'percent', milestones: [{ percentBps: 5000 }, { percentBps: 5000 }] })
      .expect(200);
    const res = await request(templateApp).get(`/api/v1/templates/${created.body.id}`).expect(200);
    expect(res.body.mode).toBe('percent');
    expect(res.body.milestones[0].percentBps).toBe(5000);
  });
});
