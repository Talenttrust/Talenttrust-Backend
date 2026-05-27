import express from 'express';
import http from 'http';

jest.mock('../database', () => ({
  database: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

const mockGetReport = jest.fn();

jest.mock('../services/dependency-scan.service', () => ({
  DependencyScanService: jest.fn().mockImplementation(() => ({
    getReport: mockGetReport,
  })),
}));

import dependencyScanRouter from './dependency-scan.routes';

const mockReport = {
  status: 'clean',
  scannedAt: '2026-01-01T00:00:00.000Z',
  summary: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  vulnerabilities: [],
  recommendation: 'No production dependency vulnerabilities detected.',
};

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('dependency-scan router', () => {
  let server: http.Server;

  beforeAll((done: jest.DoneCallback) => {
    mockGetReport.mockResolvedValue(mockReport);
    const app = express();
    app.use(express.json());
    app.use('/', dependencyScanRouter);
    const s = app.listen(0, '127.0.0.1', done);
    void (server = s);
  });

  afterAll((done) => {
    void server.close(done);
  });

  it('GET / without Authorization header returns 401', async () => {
    const res = await request(server, 'GET', '/');
    expect(res.statusCode).toBe(401);
  });

  it('GET / with non-admin token returns 403', async () => {
    const res = await request(server, 'GET', '/', {
      Authorization: 'Bearer demo-user-token',
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Admin access required' });
  });

  it('GET / with admin token returns 200 and report', async () => {
    const res = await request(server, 'GET', '/', {
      Authorization: 'Bearer demo-admin-token',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('success');
    expect(body.data).toMatchObject({ status: 'clean' });
  });

  it('GET / with admin token returns application/json content-type', async () => {
    const res = await request(server, 'GET', '/', {
      Authorization: 'Bearer demo-admin-token',
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
