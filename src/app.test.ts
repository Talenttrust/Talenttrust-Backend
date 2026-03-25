import request from 'supertest';

import { createApp } from './app';

describe('app routes', () => {
  const app = createApp();

  it('returns the health payload', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'talenttrust-backend',
    });
  });

  it('returns the incident response catalog', async () => {
    const response = await request(app).get('/api/v1/incident-response');

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(3);
    expect(response.body.runbooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'api-outage',
          title: 'API Outage Triage and Recovery',
        }),
      ]),
    );
  });

  it('returns the contracts placeholder payload', async () => {
    const response = await request(app).get('/api/v1/contracts');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contracts: [] });
  });

  it('returns a detailed runbook by id', async () => {
    const response = await request(app).get('/api/v1/incident-response/data-integrity');

    expect(response.status).toBe(200);
    expect(response.body.runbook).toMatchObject({
      id: 'data-integrity',
      title: 'Data Integrity Incident Response',
      securityNotes: expect.arrayContaining([
        'Manual data repair requires dual review for production commands.',
      ]),
    });
  });

  it('accepts normalized runbook ids in the route', async () => {
    const response = await request(app).get('/api/v1/incident-response/%20SECURITY-BREACH%20');

    expect(response.status).toBe(200);
    expect(response.body.runbook.id).toBe('security-breach');
  });

  it('returns 400 for invalid runbook ids', async () => {
    const response = await request(app).get('/api/v1/incident-response/security%2Fbreach');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Invalid runbook id/);
  });

  it('returns 404 for unknown runbook ids', async () => {
    const response = await request(app).get('/api/v1/incident-response/unknown-runbook');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('unknown-runbook');
  });
});
