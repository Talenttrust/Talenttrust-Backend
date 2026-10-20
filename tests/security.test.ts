import { createHash } from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { docsCsp, docsHtml } from '../src/openapi';
import { normalizeOrigin, parseOrigins } from '../src/cors';

const ALLOWED = 'https://allowed.example';
const app = createApp(new EscrowStore(), [ALLOWED, 'http://localhost:3000']);

const sha256Source = (source: string) => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;

describe('CORS origin allowlist', () => {
  it('normalises origins', () => {
    expect(normalizeOrigin('https://Example.COM/app/')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com:443')).toBe('https://example.com');
    expect(normalizeOrigin('not a url')).toBeUndefined();
    expect(normalizeOrigin('null')).toBeUndefined();
    expect(normalizeOrigin('')).toBeUndefined();
  });

  it('parses a comma-separated allowlist and drops invalid entries', () => {
    expect(parseOrigins('https://a.example, https://b.example/ , , *, not-a-url')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins('https://dup.example,https://dup.example')).toEqual(['https://dup.example']);
  });

  it('allows requests without an Origin header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects allowlisted origins on preflight and actual requests', async () => {
    const pre = await request(app)
      .options('/api/v1/contracts')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    expect(pre.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(pre.headers['access-control-max-age']).toBe('600');
    expect(pre.headers['vary']).toContain('Origin');

    const get = await request(app).get('/api/v1/stats').set('Origin', 'http://localhost:3000');
    expect(get.status).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('rejects non-allowlisted origins with 403 before any handler runs', async () => {
    const post = await request(app)
      .post('/api/v1/contracts')
      .set('Origin', 'https://evil.example')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] });
    expect(post.status).toBe(403);
    expect(post.body.error).toBe('origin_not_allowed');
    expect(post.headers['access-control-allow-origin']).toBeUndefined();

    const pre = await request(app)
      .options('/api/v1/contracts')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();

    const get = await request(app).get('/api/v1/contracts').set('Origin', 'https://evil.example');
    expect(get.status).toBe(403);
    expect(get.headers['access-control-allow-origin']).toBeUndefined();

    const opaque = await request(app).get('/api/v1/contracts').set('Origin', 'null');
    expect(opaque.status).toBe(403);
  });

  it('allows same-origin requests not present in the allowlist', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Host', 'api.self.example')
      .set('Origin', 'http://api.self.example')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] });
    expect(res.status).toBe(201);
  });

  it('recognises same-origin requests behind a proxy (X-Forwarded-Proto)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Host', 'api.self.example')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://api.self.example')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] });
    expect(res.status).toBe(201);
  });
});

describe('Content-Security-Policy', () => {
  const csp = (res: request.Response) => res.headers['content-security-policy'] as string;

  it('is sent on JSON, docs and error responses', async () => {
    for (const path of ['/', '/health', '/openapi.json', '/api/v1/stats', '/docs', '/nope']) {
      const res = await request(app).get(path);
      expect(csp(res)).toContain("default-src 'self'");
    }
    const err = await request(app).get('/api/v1/contracts/999');
    expect(csp(err)).toContain("object-src 'none'");
  });

  it('locks down scripts and styles without unsafe-inline', async () => {
    const policy = csp(await request(app).get('/'));
    const scriptSrc = policy.match(/script-src[^;]*/)?.[0] ?? '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain('https://unpkg.com');
    expect(scriptSrc).toContain(docsCsp.script);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(policy).toContain("script-src-attr 'none'");
    const styleSrc = policy.match(/style-src[^;]*/)?.[0] ?? '';
    expect(styleSrc).toContain(docsCsp.style);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it('serves the docs page with SRI-pinned CDN assets', async () => {
    const res = await request(app).get('/docs');
    expect(res.text).toContain('integrity="sha384-');
    expect(res.text).toContain('crossorigin="anonymous"');
    const link = /<link rel="stylesheet" href="([^"]+)" integrity="(sha384-[^"]+)" crossorigin="anonymous" \/>/.exec(
      res.text,
    );
    const script = /<script src="([^"]+)" integrity="(sha384-[^"]+)" crossorigin="anonymous"><\/script>/.exec(
      res.text,
    );
    expect(link?.[1]).toContain('swagger-ui-dist@5.17.14/swagger-ui.css');
    expect(script?.[1]).toContain('swagger-ui-dist@5.17.14/swagger-ui-bundle.js');
    expect(link?.[2]).toHaveLength('sha384-'.length + 64);
    expect(script?.[2]).toHaveLength('sha384-'.length + 64);
  });

  it('CSP hashes match the docs page inline style and script exactly', async () => {
    const html = (await request(app).get('/docs')).text;
    expect(html).toBe(docsHtml);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(style).toBeDefined();
    expect(inlineScripts).toHaveLength(1);
    expect(docsCsp.style).toBe(sha256Source(style as string));
    expect(docsCsp.script).toBe(sha256Source(inlineScripts[0]));
  });
});
