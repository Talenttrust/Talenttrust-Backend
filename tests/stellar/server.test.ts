import { config } from '../../src/config';
import { createRpcServer, getRpcServer, resetRpcServer } from '../../src/stellar/server';

describe('Stellar RPC Server Factory', () => {
  beforeEach(() => {
    resetRpcServer();
  });

  afterEach(() => {
    resetRpcServer();
  });

  describe('createRpcServer', () => {
    it('creates a new server instance with defaults', () => {
      const server = createRpcServer();
      expect(server).toBeDefined();
      expect(server.serverURL).toBeDefined();
    });

    it('creates a server with custom URL and options', () => {
      const server = createRpcServer('http://localhost:8000', {
        timeout: 5000,
        allowHttp: true,
        headers: { 'X-Custom-Header': 'test-val' },
      });
      expect(server).toBeDefined();
    });
  });

  describe('getRpcServer', () => {
    it('returns the same instance for repeated calls with the same URL', () => {
      const server1 = getRpcServer(config.rpcUrl);
      const server2 = getRpcServer(config.rpcUrl);
      expect(server1).toBe(server2);
    });

    it('returns different instances for different URLs', () => {
      const server1 = getRpcServer('https://rpc-1.example.com');
      const server2 = getRpcServer('https://rpc-2.example.com');
      expect(server1).not.toBe(server2);
    });
  });

  describe('resetRpcServer', () => {
    it('clears specific URL instance when passed a URL argument', () => {
      const server1 = getRpcServer('https://rpc-1.example.com');
      const server2 = getRpcServer('https://rpc-2.example.com');

      resetRpcServer('https://rpc-1.example.com');

      const server1New = getRpcServer('https://rpc-1.example.com');
      const server2Cached = getRpcServer('https://rpc-2.example.com');

      expect(server1New).not.toBe(server1);
      expect(server2Cached).toBe(server2);
    });

    it('clears all memoized servers when called without arguments', () => {
      const server1 = getRpcServer('https://rpc-1.example.com');
      const server2 = getRpcServer('https://rpc-2.example.com');

      resetRpcServer();

      const server1New = getRpcServer('https://rpc-1.example.com');
      const server2New = getRpcServer('https://rpc-2.example.com');

      expect(server1New).not.toBe(server1);
      expect(server2New).not.toBe(server2);
    });
  });
});
