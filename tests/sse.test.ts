import http, { IncomingMessage } from 'http';
import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return { server, port: address.port };
}

async function connect(port: number, path: string, lastEventId?: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} }, resolve);
    req.once('error', reject);
  });
}

function waitForText(response: IncomingMessage, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}; received ${body}`)), 2000);
    response.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.includes(expected)) {
        clearTimeout(timeout);
        resolve(body);
      }
    });
    response.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('contract SSE stream', () => {
  const createContract = (store: EscrowStore) => store.create({ client: 'GA', freelancer: 'GB', milestones: [100] });

  it('streams only matching contract events with public JSON', async () => {
    const store = new EscrowStore();
    const contract = createContract(store);
    const other = createContract(store);
    const app = createApp(store);
    const { server, port } = await listen(app);
    const stream = await connect(port, `/api/v1/contracts/${contract.id}/stream`);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-cache');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    const received = waitForText(stream, 'event: contract.funded');
    store.deposit(other.id, 100);
    store.deposit(contract.id, 100);
    const text = await received;
    expect(text).toContain(`"id":${contract.id}`);
    expect(text).not.toContain(`"id":${other.id}`);
    stream.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('replays events after Last-Event-ID', async () => {
    const store = new EscrowStore();
    const contract = createContract(store);
    const createdEvent = store.events.replayAfter('')[0];
    store.deposit(contract.id, 100);
    const app = createApp(store);
    const { server, port } = await listen(app);
    const stream = await connect(port, `/api/v1/contracts/${contract.id}/stream`, createdEvent.eventId);
    const text = await waitForText(stream, 'event: contract.funded');
    expect(text).toContain('id: ');
    stream.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not expose dispute reasons in stream payloads', async () => {
    const store = new EscrowStore();
    const contract = createContract(store);
    const app = createApp(store);
    const { server, port } = await listen(app);
    const stream = await connect(port, `/api/v1/contracts/${contract.id}/stream`);
    const received = waitForText(stream, 'event: dispute.raised');
    const dispute = { raisedBy: 'GA', reason: 'private dispute details' };
    store.events.emit('dispute.raised', { contract: { ...contract, dispute }, dispute });
    const text = await received;
    expect(text).not.toContain('private dispute details');
    expect(text).toContain('event: dispute.raised');
    stream.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('caps connections and closes active streams during shutdown', async () => {
    const previousLimit = process.env.SSE_MAX_CONNECTIONS;
    process.env.SSE_MAX_CONNECTIONS = '1';
    const store = new EscrowStore();
    const contract = createContract(store);
    const app = createApp(store);
    const { server, port } = await listen(app);
    const first = await connect(port, `/api/v1/contracts/${contract.id}/stream`);
    first.on('data', () => undefined);
    const second = await request(`http://127.0.0.1:${port}`).get(`/api/v1/contracts/${contract.id}/stream`).expect(503);
    expect(second.body.error).toBe('sse_connection_limit');
    app.locals.closeSseStreams();
    await new Promise<void>((resolve) => first.once('end', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousLimit === undefined) delete process.env.SSE_MAX_CONNECTIONS;
    else process.env.SSE_MAX_CONNECTIONS = previousLimit;
  });
});
