import { Tracer } from '../tracing/tracer';

export interface RpcStatus {
  network: string;
  healthy: boolean;
}

export interface ContractsRpcClient {
  fetchRegistryHealth(): Promise<RpcStatus>;
}

export class StellarRpcClient implements ContractsRpcClient {
  constructor(private readonly tracer: Tracer) {}

  async fetchRegistryHealth(): Promise<RpcStatus> {
    const span = this.tracer.startSpan('contracts.rpc.fetch_registry_health', 'rpc', {
      'rpc.system': 'stellar',
      'rpc.method': 'getHealth',
    });

    try {
      return {
        network: 'testnet',
        healthy: true,
      };
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
