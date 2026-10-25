/**
 * Jest guard: no test may perform real network I/O.
 *
 * Every outbound TCP connection in Node funnels through
 * `net.Socket.prototype.connect`, and `fetch` is patched separately.
 * Local connections (supertest talks to 127.0.0.1) are still allowed.
 */
import net from 'net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

const originalConnect = net.Socket.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(net.Socket.prototype as any).connect = function guardedConnect(this: net.Socket, ...args: any[]) {
  let host = 'localhost';
  let port = 0;
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    host = first.host ?? first.hostname ?? 'localhost';
    port = first.port ?? 0;
  } else if (typeof first === 'number') {
    port = first;
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    host = first;
    port = typeof args[1] === 'number' ? args[1] : 0;
  }
  if (!LOCAL_HOSTS.has(String(host))) {
    throw new Error(`Test guard: outbound network disabled (attempted ${host}:${port})`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalConnect as any).apply(this, args);
};

const originalFetch = globalThis.fetch?.bind(globalThis);
if (originalFetch) {
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(
      typeof input === 'string' || input instanceof URL ? input : (input && input.url) || '',
    );
    if (url && !/localhost|127\.0\.0\.1|\[::1\]/.test(url)) {
      return Promise.reject(new Error(`Test guard: outbound fetch disabled (${url})`));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

export {};
