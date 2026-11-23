import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { constantTimeEqual, Histogram } from '../src/metrics';

function metricLine(body: string, name: string, labels: Record<string, string>): string | undefined {
  const labelPairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
  const prefix = `${name}{${labelPairs}} `;
  for (const line of body.split('\n')) {
    if (line.startsWith(prefix)) return line;
  }
  return undefined;
}

function metricValue(body: string, name: string, labels: Record<string, string>): number | undefined {
  const line = metricLine(body, name, labels);
  if (!line) return undefined;
  return parseFloat(line.trim().split(/\s+/).pop()!);
}

describe('Prometheus metrics', () => {
  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it('constant-time token comparison', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('Bearer x', 'Bearer y')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('returns 404 when METRICS_TOKEN is unset', async () => {
    delete process.env.METRICS_TOKEN;
    const app = createApp(new EscrowStore());
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app = createApp(new EscrowStore());
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app = createApp(new EscrowStore());
    const res = await request(app).get('/metrics').set('authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid exposition format', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app = createApp(new EscrowStore());
    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toContain('text/plain');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('# TYPE escrow_mutations_total counter');
    expect(res.text).toContain('# TYPE escrow_contracts gauge');
    expect(res.text).toContain('# TYPE process_uptime_seconds gauge');
    expect(res.text).toContain('# TYPE nodejs_heap_used_bytes gauge');
  });

  it('counts requests by route pattern, not raw path', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app = createApp(new EscrowStore());
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/contracts/999').expect(404);
    }
    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    const line = res.text.split('\n').find((l) =>
      l.includes('http_requests_total') && l.includes('method="GET"') && l.includes('status="404"')
    );
    expect(line).toBeDefined();
    // Route should be a pattern, not the raw path with ID
    expect(line).not.toContain('999');
    expect(line).toContain(':id');
    const value = parseFloat(line!.trim().split(/\s+/).pop()!);
    expect(value).toBe(3);
  });

  it('increments escrow_mutations_total for over_funded deposit', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app = createApp(new EscrowStore());
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] })
      .expect(201);
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1 }).expect(409);

    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    const value = metricValue(res.text, 'escrow_mutations_total', { action: 'deposit', result: 'over_funded' });
    expect(value).toBe(1);
  });

  it('does not share counters between two createApp() instances', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app1 = createApp(new EscrowStore().seed());
    await request(app1).get('/api/v1/contracts/1').expect(200);

    const app2 = createApp(new EscrowStore());
    const res2 = await request(app2).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res2.status).toBe(200);
    expect(res2.text).not.toContain(':id');

    const res1 = await request(app1).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res1.status).toBe(200);
    expect(res1.text).toContain(':id');
  });
});

describe('Histogram', () => {
  it('emits all configured buckets in ascending order ending with +Inf for a single observation', () => {
    const buckets = [0.1, 0.01, 1, 0.05, 0.5];
    const histogram = new Histogram('test_duration_seconds', 'Test duration', ['method'], buckets);
    histogram.observe({ method: 'GET' }, 0.04);

    const samples = histogram.exposition();
    const bucketSamples = samples.filter((s) => s.name === 'test_duration_seconds_bucket');

    // Expected ascending order of le:
    const expectedLes = ['0.01', '0.05', '0.1', '0.5', '1', '+Inf'];
    expect(bucketSamples.map((s) => s.labels.le)).toEqual(expectedLes);

    // Cumulative counts: value 0.04 is > 0.01, <= 0.05, <= 0.1, <= 0.5, <= 1, <= +Inf
    expect(bucketSamples.map((s) => s.value)).toEqual([0, 1, 1, 1, 1, 1]);

    const countSample = samples.find((s) => s.name === 'test_duration_seconds_count');
    const infSample = bucketSamples.find((s) => s.labels.le === '+Inf');
    expect(countSample?.value).toBe(1);
    expect(infSample?.value).toBe(countSample?.value);
  });

  it('accumulates multiple observations with cumulative counts matching +Inf and _count', () => {
    const histogram = new Histogram('test_request_duration_seconds', 'Help', [], [1, 5, 10]);
    histogram.observe({}, 0.5);
    histogram.observe({}, 2.5);
    histogram.observe({}, 7.0);
    histogram.observe({}, 12.0);

    const samples = histogram.exposition();
    const bucketSamples = samples.filter((s) => s.name === 'test_request_duration_seconds_bucket');

    expect(bucketSamples.map((s) => s.labels.le)).toEqual(['1', '5', '10', '+Inf']);
    // <= 1: 1 (0.5)
    // <= 5: 2 (0.5, 2.5)
    // <= 10: 3 (0.5, 2.5, 7.0)
    // <= +Inf: 4
    expect(bucketSamples.map((s) => s.value)).toEqual([1, 2, 3, 4]);

    const countSample = samples.find((s) => s.name === 'test_request_duration_seconds_count');
    expect(countSample?.value).toBe(4);
    const sumSample = samples.find((s) => s.name === 'test_request_duration_seconds_sum');
    expect(sumSample?.value).toBe(22);
  });
});
