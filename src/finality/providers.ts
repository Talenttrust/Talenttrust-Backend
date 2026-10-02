/**
 * @module finality/providers
 * @description Chain-head providers for the finality evaluator.
 *
 * Soroban runs on Stellar, so the Soroban RPC `getLatestLedger` head is
 * the shared ledger sequence for both the `soroban` and `stellar`
 * networks. The default provider maps both names to that single RPC
 * call; operators can inject any {@link LatestLedgerProvider}.
 */

import { SorobanRpcService } from '../services/soroban/SorobanRpcService';
import { LatestLedgerProvider } from './finalityEvaluator';

/** Networks served by the Soroban RPC head. */
const SOROBAN_NETWORKS = new Set(['soroban', 'stellar']);

/**
 * Default chain-head provider backed by {@link SorobanRpcService}.
 *
 * @throws When the RPC call fails (the evaluator converts this into a
 *         fail-closed `provisional` outcome).
 */
export function createSorobanLatestLedgerProvider(
  service: SorobanRpcService = new SorobanRpcService(),
): LatestLedgerProvider {
  return async (network: string): Promise<number> => {
    if (!SOROBAN_NETWORKS.has(network)) {
      throw new Error(`Unsupported finality provider for network: ${network}`);
    }
    const response = await service.getLatestLedger();
    return response.sequence;
  };
}
