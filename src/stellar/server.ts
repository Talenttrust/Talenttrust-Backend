import { rpc } from '@stellar/stellar-sdk';
import { config } from '../config';

export interface RpcServerOptions {
  timeout?: number;
  allowHttp?: boolean;
  headers?: Record<string, string>;
}

const memoizedServers = new Map<string, rpc.Server>();

export function createRpcServer(
  rpcUrl: string = config.rpcUrl,
  options?: RpcServerOptions,
): rpc.Server {
  const timeout = options?.timeout ?? config.rpcTimeoutMs;
  const allowHttp = options?.allowHttp ?? rpcUrl.startsWith('http://');
  const headers = options?.headers;

  return new rpc.Server(rpcUrl, {
    timeout,
    allowHttp,
    headers,
  });
}

export function getRpcServer(
  rpcUrl: string = config.rpcUrl,
  options?: RpcServerOptions,
): rpc.Server {
  const existing = memoizedServers.get(rpcUrl);
  if (existing) {
    return existing;
  }
  const server = createRpcServer(rpcUrl, options);
  memoizedServers.set(rpcUrl, server);
  return server;
}

export function resetRpcServer(rpcUrl?: string): void {
  if (rpcUrl) {
    memoizedServers.delete(rpcUrl);
  } else {
    memoizedServers.clear();
  }
}
